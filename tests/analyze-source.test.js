import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeSource, DEFAULT_EXPORT_LOCAL } from '../src/analyze-source.js';

const META = 'export const meta = {};\n';

// Each rule that one file shows, with one script that breaks it and one that passes it.
const RULE_CASES = [
  { rule: 'syntax-error', isEntry: false, breaking: 'const = 1;\n', passing: 'const a = 1;\n' },
  { rule: 'syntax-error', isEntry: false, breaking: '#!/usr/bin/env node\n', passing: '// a comment\n' },
  { rule: 'syntax-error', isEntry: false, breaking: 'export const f = (n) => 0 <!--n;\n', passing: "export const f = (n) => [0 < !--n, '<!--', `<!--`];\n" },
  { rule: 'meta-not-first', isEntry: true, breaking: "import './a.js';\nexport const meta = {};\n", passing: `${META}import './a.js';\n` },
  { rule: 'meta-not-alone', isEntry: true, breaking: "export const meta = {}; log(1);\nimport './a.js';\n", passing: "export const meta = {};\nlog(1);\nimport './a.js';\n" },
  { rule: 'meta-not-alone', isEntry: true, breaking: "export const meta = {}; import './a.js'; log(1);", passing: "export const meta = {}; import './a.js';\nlog(1);" },
  { rule: 'meta-not-alone', isEntry: true, breaking: "export const meta = {}; /* a\n */\nimport './a.js';\n", passing: "export const meta = {}; /* a */\nimport './a.js';\n" },
  { rule: 'meta-not-alone', isEntry: true, breaking: 'export const meta = {}; /* a\n */ log(1);\n', passing: 'export const meta = {}; /* a */ log(1);\n' },
  { rule: 'meta-not-alone', isEntry: true, breaking: 'export const meta = {}; const p = `a\nb`;\n', passing: 'export const meta = {}; const p = `a${\n1}b`;\n' },
  { rule: 'meta-not-alone', isEntry: true, breaking: "export const meta = {}; const q = 'a\\\nb';\n", passing: "export const meta = {}; const q = 'a\\nb';\n" },
  { rule: 'meta-reads-import', isEntry: true, breaking: "export const meta = { name: NAME };\nimport { NAME } from './a.js';\n", passing: "export const meta = { name: (NAME) => NAME };\nimport { NAME } from './a.js';\n" },
  { rule: 'entry-export', isEntry: true, breaking: `${META}export const other = 1;\n`, passing: `${META}const other = 1;\n` },
  { rule: 'entry-export', isEntry: true, breaking: `${META}export {};\n`, passing: `${META}({});\n` },
  { rule: 'import-not-relative', isEntry: false, breaking: "import 'lib/a.js';\n", passing: "import './lib/a.js';\n" },
  { rule: 'import-not-module', isEntry: false, breaking: "import './a.json';\n", passing: "import './a.mjs';\n" },
  { rule: 'import-dynamic', isEntry: false, breaking: "export const load = () => import('./a.js');\n", passing: "export const load = () => 'import(./a.js)';\n" },
  { rule: 'import-meta', isEntry: false, breaking: 'export const url = import.meta.url;\n', passing: 'export const url = null;\n' },
  { rule: 'export-not-constant', isEntry: false, breaking: 'export let count = 0;\n', passing: 'export const count = 0;\n' },
  { rule: 'export-not-constant', isEntry: false, breaking: 'export const count = 0;\nfunction raise() { count += 1; }\n', passing: 'export const count = 0;\nfunction raise(count) { count += 1; }\n' },
  { rule: 'export-from', isEntry: false, breaking: "export * from './a.js';\n", passing: "import * as a from './a.js';\nexport { a };\n" },
  { rule: 'module-top-level-await', isEntry: false, breaking: 'await 1;\n', passing: 'export async function wait() { await 1; }\n' },
  { rule: 'module-top-level-await', isEntry: false, breaking: 'return;\n', passing: 'export function stop() { return; }\n' },
  { rule: 'module-top-level-await', isEntry: false, breaking: 'await using x = null;\n', passing: 'export async function hold() { await using x = null; }\n' },
  { rule: 'module-top-level-await', isEntry: false, breaking: 'for (await using x of []);\n', passing: 'for (using x of []);\n' },
  { rule: 'module-top-level-this', isEntry: false, breaking: 'export const self = this;\n', passing: 'export function self() { return this; }\n' },
  { rule: 'module-top-level-this', isEntry: false, breaking: "export class K { [String(this)] = 1; }\n", passing: 'export class K { key = this; }\n' },
  { rule: 'module-direct-eval', isEntry: false, breaking: "export const read = () => eval('step');\n", passing: "export const read = () => (0, eval)('step');\n" },
  { rule: 'module-direct-eval', isEntry: false, breaking: "export const read = () => (eval)('step');\n", passing: "export const read = () => eval?.('step');\n" },
  { rule: 'reserved-name', isEntry: false, breaking: 'const __dwfb_x = 1;\n', passing: 'const dwfb_x = 1;\n' },
  { rule: 'reserved-name', isEntry: false, breaking: 'export const o = { __dwfb_x };\n', passing: 'export const o = { __dwfb_x: 1, __dwfb_y() {} };\n' },
  { rule: 'reserved-name', isEntry: false, breaking: 'export const o = __dwfb_x.y;\n', passing: 'export const o = x.__dwfb_y;\n' },
  { rule: 'reserved-name', isEntry: false, breaking: "import { __dwfb_x } from './a.js';\n", passing: "import { __dwfb_x as x } from './a.js';\nexport { x as __dwfb_y };\n" },
  { rule: 'reserved-name', isEntry: false, breaking: 'const { __dwfb_x } = o;\n', passing: '__dwfb_x: for (const { __dwfb_y: y } of []) break __dwfb_x;\n' },
  { rule: 'reserved-name', isEntry: true, breaking: `${META}import './a.js';\nconst Object = 1;\n`, passing: `${META}const Object = 1;\n` },
  { rule: 'reserved-name', isEntry: true, breaking: `${META}import './a.js';\nclass Symbol {}\n`, passing: `${META}class Symbol {}\n` },
];

/**
 * @param {string} text
 * @param {boolean} isEntry
 * @param {boolean} [hasBanner]
 * @returns {string[]} The rule ids of the findings.
 */
function listRules(text, isEntry, hasBanner = true) {
  return analyzeSource(text, '/work/file.js', isEntry, hasBanner).findings.map((finding) => finding.rule);
}

describe('analyzeSource rules', () => {
  for (const { rule, isEntry, breaking, passing } of RULE_CASES) {
    it(`reports ${rule} for ${JSON.stringify(breaking)} and not for ${JSON.stringify(passing)}`, () => {
      assert.ok(listRules(breaking, isEntry).includes(rule));
      assert.ok(!listRules(passing, isEntry).includes(rule));
    });
  }

  it('reports reserved-name once for the one node that names both sides of a shorthand import or export', () => {
    assert.deepEqual(listRules("import { __dwfb_x } from './a.js';\n", false), ['reserved-name']);
    assert.deepEqual(listRules('const __dwfb_x = 1;\nexport { __dwfb_x };\n', false), ['reserved-name', 'reserved-name']);
  });

  it('allows code on the meta line of an entry that imports nothing', () => {
    assert.deepEqual(listRules('export const meta = {}; log(1);\n', true), []);
  });

  it('allows a comment and a literal across the meta line break of an entry with no import and no banner', () => {
    assert.deepEqual(listRules('export const meta = {}; /* a\n */ const p = `a\nb`;\n', true, false), []);
  });
});

describe('analyzeSource reads', () => {
  it('reads each import binding and each export', () => {
    const text = "import a, { b as c } from './a.js';\nimport * as d from './d.js';\nexport const e = 1;\nexport function f() {}\nexport { e as g };\nexport default 2;\n";
    const analysis = analyzeSource(text, '/work/file.js', false);

    assert.deepEqual(analysis.imports.map((record) => [record.specifier, record.bindings.map((binding) => `${binding.imported}:${binding.local}`)]), [
      ['./a.js', ['default:a', 'b:c']],
      ['./d.js', ['*:d']],
    ]);
    assert.deepEqual(analysis.exports.map((record) => `${record.exported}:${record.local}`), ['e:e', 'f:f', 'g:e', `default:${DEFAULT_EXPORT_LOCAL}`]);
  });

  it('keeps the parentheses of a default value inside the rewritten statement', () => {
    const text = 'export default ({ a: 1 });\n';
    const { edits } = analyzeSource(text, '/work/file.js', false);
    const rewritten = edits.reduceRight((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text);

    assert.equal(rewritten, `const ${DEFAULT_EXPORT_LOCAL} = { default: ({ a: 1 }) }.default;\n`);
  });

  it('lists the top-level names of an entry and the free names of a module', () => {
    const entry = analyzeSource(`${META}import { a } from './a.js';\nlet b;\nif (true) { var c; let d; }\n`, '/work/entry.js', true, true);
    const module = analyzeSource('const a = 1;\nexport function f(b) { return a + b + c + log; }\n', '/work/module.js', false);

    assert.deepEqual(entry.topLevelNames.sort(), ['a', 'b', 'c', 'meta']);
    assert.deepEqual(entry.freeNames, []);
    assert.deepEqual(module.freeNames.map((freeName) => freeName.name), ['c', 'log']);
    assert.deepEqual(module.topLevelNames, []);
  });
});
