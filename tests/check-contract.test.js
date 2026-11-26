import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'dynamic-workflow-bundler';
import { checkContract, SCRIPT_BYTE_LIMIT } from '../src/check-contract.js';
import { findPosition } from '../src/source-position.js';
import { DEEP_REGEXP_LITERAL } from './support/deep-regexp-literal.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const META = "export const meta = { name: 'p', description: 'd' }\n";
const TREE_DEPTH = 20000;
const PARSER_DEPTH = 1200;

// Rules that the case table cannot hold apart, each with one script that breaks it and one that passes it.
const RULE_CASES = [
  { rule: 'runtime-reserved-name', breaking: `${META}function f(__wRg$a) { return __wRg$a; }\n`, passing: `${META}__wRg$a: for (;;) break __wRg$a;\n` },
  { rule: 'runtime-reserved-name', breaking: `${META}return __wRg$loop;\n`, passing: `${META}return ({ __wRg$a: 1 }).__wRg$a;\n` },
  { rule: 'clock-unavailable', breaking: `${META}const now = Date.now;\n`, passing: `${META}return [new Date(0), new Date(undefined), Date.parse('2026-01-01'), Date.UTC(2026, 0)];\n` },
  { rule: 'clock-unavailable', breaking: `${META}return new Date;\n`, passing: `${META}const { now } = Date;\n` },
  { rule: 'clock-unavailable', breaking: `${META}return Date\`x\`;\n`, passing: `${META}return String.raw\`x\`;\n` },
  { rule: 'clock-unavailable', breaking: `${META}return Date[\`now\`]();\n`, passing: `${META}return Date[\`parse\`]('2026-01-01');\n` },
  { rule: 'random-unavailable', breaking: `${META}return Math['random']();\n`, passing: `${META}return Math.floor(1.5);\n` },
  { rule: 'random-unavailable', breaking: `${META}return Math[\`random\`]();\n`, passing: `${META}return Math[\`floor\`](1.5);\n` },
  { rule: 'eval-unavailable', breaking: `${META}return eval?.('1');\n`, passing: `${META}return (0, eval)('1');\n` },
  { rule: 'eval-unavailable', breaking: `${META}return new Function('return 1')();\n`, passing: `${META}return setTimeout('1', 0);\n` },
  { rule: 'eval-unavailable', breaking: `${META}return eval\`1\`;\n`, passing: `${META}return String.raw\`1\`;\n` },
  { rule: 'eval-unavailable', breaking: `${META}return Function\`return 1\`;\n`, passing: `${META}const Function = String.raw;\nreturn Function\`return 1\`;\n` },
  { rule: 'global-undefined', breaking: `${META}[undeclared] = [1];\n`, passing: `${META}globalThis['made'] = 1;\nreturn made;\n` },
  { rule: 'global-undefined', breaking: `${META}globalThis[\`made\${1}\`] = 1;\nreturn made1;\n`, passing: `${META}globalThis[\`made\`] = 1;\nreturn made;\n` },
  { rule: 'global-undefined', breaking: `${META}const v = made;\nglobalThis.made = 1;\nreturn v;\n`, passing: `${META}const f = () => made;\nglobalThis.made = 1;\nreturn f();\n` },
  { rule: 'global-undefined', breaking: `${META}class A { static x = made }\nglobalThis.made = 1;\n`, passing: `${META}class A { x = made }\nglobalThis.made = 1;\nreturn new A().x;\n` },
  { rule: 'global-undefined', breaking: `${META}globalThis.made = made;\n`, passing: `${META}globalThis.made ??= 1;\nglobalThis.count++;\nreturn [made, count];\n` },
  { rule: 'global-undefined', breaking: `${META}globalThis.made &&= 1;\nreturn made;\n`, passing: `${META}globalThis.made ||= 1;\nglobalThis.total += 1;\nreturn [made, total];\n` },
  { rule: 'global-undefined', breaking: `${META}for (globalThis.made of [made]);\n`, passing: `${META}for (globalThis.item of [1]) item;\n[globalThis.made] = [1];\nreturn made;\n` },
  { rule: 'global-undefined', breaking: `${META}for (globalThis.made of []);\nreturn made;\n`, passing: `${META}for (globalThis.key in { a: 1 }) { key; }\n` },
  { rule: 'global-undefined', breaking: `${META}for (globalThis.made in {});\nreturn made;\n`, passing: `${META}for (globalThis.made in {});\nglobalThis.made = 1;\nreturn made;\n` },
  { rule: 'global-undefined', breaking: `${META}for (undeclared of []);\n`, passing: `${META}return typeof (undeclared);\n` },
  { rule: 'global-undefined', breaking: `${META}const f = () => arguments;\n`, passing: `${META}const f = function () { return () => arguments; };\n` },
  { rule: 'meta-not-literal', breaking: "export const meta = { name: 'p', description: 'd', a: [...[]] };\n", passing: "export const meta = { name: 'p', description: 'd', a: [-1, /x/, 1n, null, true, `t`] };\n" },
  { rule: 'meta-name-invalid', breaking: "export const meta = { name: 'p', name: '', description: 'd' };\n", passing: "export const meta = { name: '', name: 'p', description: 'd' };\n" },
  { rule: 'meta-description-invalid', breaking: "export const meta = { name: 'p', description: `` };\n", passing: "export const meta = { name: 'p', 'description': ' ' };\n" },
  { rule: 'script-export', breaking: `${META}const a = 1;\nexport { a };\n`, passing: `${META}const a = 1;\n` },
];

/**
 * @param {number} byteCount
 * @returns {string} A script of this many bytes that breaks no rule.
 */
function fillText(byteCount) {
  return `${META}//${'a'.repeat(byteCount - META.length - 3)}\n`;
}

/**
 * @param {string} text
 * @returns {string[]} Each finding as `<rule> <line>:<column>`.
 */
function listFindings(text) {
  return checkContract(text, 'script.js').map((finding) => `${finding.rule} ${finding.line}:${finding.column}`);
}

/**
 * @param {string} text
 * @returns {string[]} The rule ids of the findings.
 */
function listRules(text) {
  return checkContract(text, 'script.js').map((finding) => finding.rule);
}

/**
 * @param {string} text
 * @param {string} code
 * @returns {string} The line and column where the first copy of `code` starts in `text`.
 */
function locate(text, code) {
  const { line, column } = findPosition(text, text.indexOf(code));
  return `${line}:${column}`;
}

describe('checkContract', () => {
  for (const { rule, breaking, passing } of RULE_CASES) {
    it(`reports ${rule} for ${JSON.stringify(breaking)} and not for ${JSON.stringify(passing)}`, () => {
      assert.ok(listRules(breaking).includes(rule));
      assert.ok(!listRules(passing).includes(rule));
    });
  }

  it('reports script-too-large past 524,288 bytes of UTF-8, at line 1, column 1, and still runs the other rules', () => {
    const multiByteText = `${META}// ${'é'.repeat(SCRIPT_BYTE_LIMIT / 2)}\nreturn Date.now();\n`;

    assert.equal(Buffer.byteLength(fillText(SCRIPT_BYTE_LIMIT)), SCRIPT_BYTE_LIMIT);
    assert.deepEqual(listFindings(fillText(SCRIPT_BYTE_LIMIT)), []);
    assert.deepEqual(listFindings(fillText(SCRIPT_BYTE_LIMIT + 1)), ['script-too-large 1:1']);
    assert.ok(multiByteText.length < SCRIPT_BYTE_LIMIT);
    assert.deepEqual(listRules(multiByteText), ['script-too-large', 'clock-unavailable']);
    assert.equal(checkContract(multiByteText, 'script.js')[0].message, `The script is ${Buffer.byteLength(multiByteText)} bytes, which is more than the 524288 bytes the runtime reads`);
  });

  it('measures script-too-large on the byte count it is given in place of the text', () => {
    assert.deepEqual(listRules(`${META}return 1;\n`), []);
    assert.deepEqual(checkContract(`${META}return 1;\n`, 'script.js', SCRIPT_BYTE_LIMIT + 1).map((finding) => `${finding.rule} ${finding.message}`), [
      'script-too-large The script is 524289 bytes, which is more than the 524288 bytes the runtime reads',
    ]);
    assert.deepEqual(checkContract(fillText(SCRIPT_BYTE_LIMIT + 1), 'script.js', SCRIPT_BYTE_LIMIT), []);
  });

  it('reports source-too-deep alone for a script nested past the parser or past the tree walks', () => {
    const parserDeepText = `${META}require(1);\nconst v = ${'{ a: '.repeat(PARSER_DEPTH)}1${' }'.repeat(PARSER_DEPTH)};\n`;
    const treeDeepText = `${META}require(1);\nconst v = typeof a${'.b'.repeat(TREE_DEPTH)};\n`;
    const parserFindings = checkContract(parserDeepText, 'script.js');

    assert.equal(parserFindings.length, 1);
    assert.equal(parserFindings[0].rule, 'source-too-deep');
    assert.equal(parserFindings[0].message, 'The script nests code deeper than the parser can read');
    assert.deepEqual(checkContract(treeDeepText, 'script.js').map((finding) => `${finding.rule} ${finding.line}:${finding.column} ${finding.message}`), [
      'source-too-deep 3:18 The script nests code deeper than dwfb can read',
    ]);
  });

  it('reports source-too-deep at 1:1 for a script whose first token nests past the parser', () => {
    assert.deepEqual(checkContract(`${DEEP_REGEXP_LITERAL};\n`, 'script.js').map((finding) => `${finding.rule} ${finding.line}:${finding.column} ${finding.message}`), [
      'source-too-deep 1:1 The script nests code deeper than the parser can read',
    ]);
  });

  it('reports syntax-error alone with the parser\'s reason', () => {
    assert.deepEqual(checkContract(`${META}require(1);\nconst = 1;\n`, 'script.js').map((finding) => `${finding.rule} ${finding.line}:${finding.column} ${finding.message}`), [
      'syntax-error 3:7 Unexpected token',
    ]);
  });

  it('reports no clock, random or eval finding for a script that declares its own Date, Math or Function', () => {
    const ownGlobals = [
      'const Date = { now: () => 0 };\nDate.now();\nnew Date();\nDate();\n',
      'const Math = { random: () => 0 };\nMath.random();\n',
      'function run(Function) { return [Function(), new Function()]; }\n',
      '{ const Date = { now: () => 0 }; Date.now(); }\n',
    ];

    for (const body of ownGlobals) assert.deepEqual(listRules(`${META}${body}`), [], body);
  });

  it('gives a script that binds its own eval the parser\'s syntax-error, since strict code cannot bind eval', () => {
    assert.deepEqual(listRules(`${META}const eval = () => 0;\neval('1');\n`), ['syntax-error']);
  });

  it('places each finding at the refused node, sorted by line and then column', () => {
    const text = [
      "export const meta = { name: 'p', description: 'd', x: f() }",
      "require('a')",
      'Date.now(); Math.random()',
      'export const y = 1',
      "import 'z'",
      '',
    ].join('\n');

    assert.deepEqual(listFindings(text), [
      `meta-not-literal ${locate(text, 'f()')}`,
      `global-undefined ${locate(text, 'require')}`,
      `clock-unavailable ${locate(text, 'Date')}`,
      `random-unavailable ${locate(text, 'Math')}`,
      `script-export ${locate(text, 'export const y')}`,
      `script-import ${locate(text, 'import')}`,
    ]);
  });

  it('places a finding as an editor shows the script, with no byte order mark and a lone CR as a line break', () => {
    assert.deepEqual(listFindings("\uFEFFexport const meta = { name: '', description: 'd' }\n"), ['meta-name-invalid 1:29']);
    assert.deepEqual(listFindings('\uFEFFreturn 1\n'), ['meta-not-first 1:1']);
    assert.deepEqual(listFindings("export const meta = { name: 'p', description: 'd' }\rconst x = 1\rreturn Date.now()\r"), ['clock-unavailable 3:8']);
    assert.deepEqual(listFindings("export const meta = { name: 'p', description: 'd' }\r\nconst x = 1\r\nreturn Date.now()\r\n"), ['clock-unavailable 3:8']);
  });

  it('names the file as given and the refused code in each message', () => {
    const text = `${META}undeclared = 1;\nrequire('a');\nreturn [meta, () => arguments];\n`;

    assert.deepEqual(checkContract(text, 'any/path.js').map((finding) => `${finding.file} ${finding.message}`), [
      'any/path.js The script assigns undeclared, which the runtime does not define',
      'any/path.js The script reads require, which the runtime does not define',
      'any/path.js The script reads meta, which the runtime does not define after the meta statement',
      'any/path.js The script reads arguments where no function binds it',
    ]);
  });

  it('names a joiner inside an undefined name by its JavaScript escape', () => {
    assert.deepEqual(checkContract(`${META}return a\u200Db;\n`, 'script.js').map((finding) => `${finding.rule} ${finding.message}`), [
      'global-undefined The script reads a\\u{200D}b, which the runtime does not define',
    ]);
  });

  it('gives each global-undefined finding the fix that fits the name it reports', () => {
    const text = `${META}require('a');\nprocess;\nreturn [meta, () => arguments];\n`;

    assert.deepEqual(checkContract(text, 'script.js').map((finding) => `${finding.rule} ${finding.fix}`), [
      'global-undefined Declare the name, or pass the value through args',
      'global-undefined Declare the name, or pass the value through args',
      'global-undefined Copy the values the body needs into a constant of another name',
      'global-undefined Read it only inside a function that is not an arrow function',
    ]);
  });

  it('reports global-undefined once per name, at its first occurrence that counts', () => {
    const text = `${META}typeof later;\nlater;\nlater;\n`;
    assert.deepEqual(listFindings(text), ['global-undefined 3:1']);
  });

  it('reports each refused node of the meta object and skips the name and description checks then', () => {
    const text = "export const meta = { name: x, description: 5, a: `${1}`, b: [1, , 2], ['c']: 1, d() {}, constructor: 1 };\n";
    assert.deepEqual(listFindings(text), [
      `meta-not-literal ${locate(text, 'x,')}`,
      `meta-not-literal ${locate(text, '`${1}`')}`,
      `meta-not-literal ${locate(text, '[1, , 2]')}`,
      `meta-not-literal ${locate(text, "['c']")}`,
      `meta-not-literal ${locate(text, 'd()')}`,
      `meta-not-literal ${locate(text, 'constructor')}`,
    ]);
  });

  it('passes the script that the build gives for the modules fixture', async () => {
    const result = await build({ entry: join(FIXTURES, 'modules', 'entry.js'), out: join(FIXTURES, 'modules', 'out.js'), write: false });

    assert.equal(result.ok, true);
    assert.deepEqual(checkContract(result.script, 'out.js'), []);
  });
});
