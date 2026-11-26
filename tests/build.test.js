import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse as parsePath, relative } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { build } from 'dynamic-workflow-bundler';
import { compileBuiltScript } from '../src/build.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const MODULES_ENTRY = join(FIXTURES, 'modules', 'entry.js');
// The script body hooks of Claude Code 2.1.332, as its workflow script reference lists them.
const RUNTIME_GLOBALS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow'];

const temporaryFolders = [];
after(async () => {
  for (const folder of temporaryFolders) await rm(folder, { recursive: true, force: true });
});

/** @returns {Promise<string>} */
async function makeTemporaryFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'dwfb-build-'));
  temporaryFolders.push(folder);
  return folder;
}

/**
 * Runs a built script as Claude Code 2.1.332 does, as the body of a strict async arrow function after its
 * meta statement, with stand-ins for the runtime globals.
 * @param {string} script
 * @param {object} scriptArgs
 */
async function runBuiltScript(script, scriptArgs) {
  const program = parse(script, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  const body = script.slice(program.body[0].end);
  const logLines = [];
  const standIns = { agent: async () => null, parallel: async () => [], pipeline: async () => [], phase: () => {}, log: (line) => logLines.push(line), args: scriptArgs, budget: {}, workflow: {} };
  const run = new Function(...RUNTIME_GLOBALS, `return (async () => {'use strict';${body}\n})();`);
  const value = await run(...RUNTIME_GLOBALS.map((name) => standIns[name]));
  return { value, logLines };
}

/**
 * @param {string} firstPath
 * @param {string} secondPath
 * @returns {boolean} True when the two paths sit on one drive.
 */
function hasSameRoot(firstPath, secondPath) {
  return parsePath(firstPath).root.toLowerCase() === parsePath(secondPath).root.toLowerCase();
}

/** @param {string} path */
function formatForwardSlashes(path) {
  return path.split('\\').join('/');
}

/**
 * @param {string} folder A fixture folder, relative to the fixtures folder.
 * @param {string} file A reported path, relative to the working directory.
 */
function formatFixturePath(folder, file) {
  return formatForwardSlashes(relative(join(FIXTURES, folder), join(process.cwd(), file)));
}

describe('build of the modules fixture', async () => {
  const result = await build({ entry: MODULES_ENTRY, out: join(FIXTURES, 'modules', 'out.js'), write: false });

  it('finds nothing', () => {
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
  });

  it('runs every import and export form as ES modules do, apart from a namespace that is frozen, not sealed', async () => {
    const { value, logLines } = await runBuiltScript(result.script, { task: 'check' });

    assert.deepEqual(logLines, ['counter', 'greet', 'shapes', 'side effect', 'reader', 'prompt', 'entry']);
    assert.deepEqual(value, {
      countBeforeImport: 1,
      count: 2,
      sharedCount: 2,
      greeting: 'Hello, agent. Call 3.',
      greetName: 'default',
      shapesDefault: 'shapes default',
      isNamespaceFrozen: true,
      namespaceKeys: ['Square', 'corners', 'default', 'delayed', 'tall', 'width'],
      namespaceDefault: 'shapes default',
      area: 9,
      kind: 'square',
      corners: ['top', 'bottom'],
      delayed: 'later',
      width: 2,
      tall: 3,
      prompt: "First line of the prompt.\nimport { nothing } from './nowhere.js';\n    An indented line.",
      task: 'check',
    });
  });

  it('lists every source file, entry first', () => {
    const sources = result.sources.map((file) => formatFixturePath('modules', file));
    assert.deepEqual(sources, ['entry.js', 'lib/counter.js', 'lib/greet.js', 'lib/shapes.js', 'lib/side-effect.js', 'lib/reader.js', 'lib/prompt.mjs']);
  });

  it('keeps each line that is not an import or export byte for byte, at a fixed distance from the first line of its file', async () => {
    const builtLines = result.script.split('\n');

    for (const path of ['lib/counter.js', 'lib/greet.js', 'lib/shapes.js', 'lib/reader.js', 'lib/prompt.mjs']) {
      const moduleLines = (await readFile(join(FIXTURES, 'modules', path), 'utf8')).replace(/\n$/, '').split('\n');
      const firstLine = builtLines.indexOf(`// ${path}`) + 2;
      moduleLines.forEach((line, index) => {
        if (!/^(import|export) /.test(line)) assert.equal(builtLines[firstLine + index], line, `${path} line ${index + 1}`);
      });
      assert.match(builtLines[firstLine + moduleLines.length], /^return \{ __proto__: null/);
    }

    const entryLines = (await readFile(MODULES_ENTRY, 'utf8')).split('\n');
    const entryRestStart = builtLines.length - (entryLines.length - 4);
    assert.deepEqual(builtLines.slice(0, 4), entryLines.slice(0, 4));
    entryLines.slice(4).forEach((line, index) => {
      if (!line.startsWith('import ')) assert.equal(builtLines[entryRestStart + index], line, `entry line ${index + 5}`);
    });
  });

  it('opens with the meta statement, then the banner', () => {
    const lines = result.script.split('\n');
    assert.equal(lines[4], '// Built by dynamic-workflow-bundler from entry.js. Edit the source, not this file.');
  });
});

describe('build findings', () => {
  const cases = [
    { rule: 'syntax-error', file: 'broken.js', line: 2 },
    { rule: 'meta-not-first', file: 'entry.js', line: 1 },
    { rule: 'meta-not-alone', file: 'entry.js', line: 1 },
    { rule: 'meta-reads-import', file: 'entry.js', line: 2 },
    { rule: 'entry-export', file: 'entry.js', line: 2 },
    { rule: 'import-not-relative', file: 'entry.js', line: 2 },
    { rule: 'import-not-module', file: 'entry.js', line: 2 },
    { rule: 'import-not-module', file: 'entry.js', line: 3 },
    { rule: 'import-not-found', file: 'entry.js', line: 2 },
    { rule: 'import-not-exported', file: 'entry.js', line: 2 },
    { rule: 'import-cycle', file: 'second.js', line: 1 },
    { rule: 'import-dynamic', file: 'entry.js', line: 2 },
    { rule: 'import-meta', file: 'location.js', line: 1 },
    { rule: 'export-not-constant', file: 'state.js', line: 1 },
    { rule: 'export-not-constant', file: 'state.js', line: 6 },
    { rule: 'export-from', file: 'barrel.js', line: 1 },
    { rule: 'module-top-level-await', file: 'ready.js', line: 1 },
    { rule: 'module-top-level-await', file: 'ready.js', line: 3 },
    { rule: 'module-top-level-this', file: 'context.js', line: 1 },
    { rule: 'module-top-level-this', file: 'context.js', line: 2 },
    { rule: 'module-top-level-this', file: 'context.js', line: 11 },
    { rule: 'module-direct-eval', file: 'reader.js', line: 2 },
    { rule: 'module-reads-entry-name', file: 'reader.js', line: 2 },
    { rule: 'reserved-name', file: 'entry.js', line: 2 },
    { rule: 'reserved-name', file: 'entry.js', line: 3 },
  ];
  const rules = [...new Set(cases.map((each) => each.rule))];

  for (const rule of rules) {
    it(`reports ${rule} with its file and line, and writes nothing`, async () => {
      const folder = join(FIXTURES, 'rules', rule);
      const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js') });
      const found = result.findings.map((finding) => ({ rule: finding.rule, file: formatFixturePath(join('rules', rule), finding.file), line: finding.line }));

      assert.equal(result.ok, false);
      assert.equal(result.script, null);
      assert.deepEqual(found, cases.filter((each) => each.rule === rule));
      assert.ok(result.findings.every((finding) => finding.message !== '' && finding.fix !== '' && finding.column >= 1));
      assert.ok(!(await readdir(folder)).includes('out.js'));
    });
  }

  it('names each file of an import cycle', async () => {
    const folder = join(FIXTURES, 'rules', 'import-cycle');
    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    assert.match(result.findings[0].message, /first\.js -> .*second\.js -> .*first\.js$/);
  });

  it('carries the parser reason in a syntax error', async () => {
    const folder = join(FIXTURES, 'rules', 'syntax-error');
    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    assert.equal(result.findings[0].message, 'Unexpected token');
    assert.equal(result.findings[0].column, 7);
  });
});

describe('build text handling', () => {
  it('reads CRLF as LF and drops a byte order mark', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "\uFEFFexport const meta = {};\r\nimport { value } from './value.js';\r\nreturn value;\r\n");
    await writeFile(join(folder, 'value.js'), '\uFEFFexport const value = `a\r\nb`;\r\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js') });
    const written = await readFile(join(folder, 'out.js'), 'utf8');

    assert.equal(result.ok, true);
    assert.equal(written, result.script);
    assert.ok(!written.includes('\r') && !written.includes('\uFEFF'));
    assert.equal((await runBuiltScript(written, {})).value, 'a\nb');
  });

  it('builds an entry with no import to its own text when the banner is off', async () => {
    const folder = await makeTemporaryFolder();
    const text = "export const meta = {\n  name: 'plain',\n};\n\nconst done = await agent('x');\nreturn `${done}\nend`;";
    await writeFile(join(folder, 'entry.js'), `\uFEFF${text.replaceAll('\n', '\r\n')}`);

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), banner: false, write: false });

    assert.equal(result.script, text);
  });

  it('puts the banner on its own line when the meta statement ends the file', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'build', 'out.js'), write: false });

    assert.equal(result.script, 'export const meta = {};\n// Built by dynamic-workflow-bundler from ../entry.js. Edit the source, not this file.\n');
  });

  it('keeps the line count of a multi-line import and export', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport {\n  value,\n} from './value.js';\nreturn value();\n");
    await writeFile(join(folder, 'value.js'), 'export default\nfunction named() {\n  return named.name;\n}\nexport {\n  named as value,\n};\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), banner: false, write: false });
    const lines = result.script.split('\n');

    assert.equal(lines.length, 1 + 2 + 7 + 1 + 1 + 4 + 1);
    assert.equal((await runBuiltScript(result.script, {})).value, 'named');
  });
});

describe('build edge forms', () => {
  it('exports string names, __proto__ and an anonymous default function declaration', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(
      join(folder, 'entry.js'),
      "export const meta = {};\nimport anonymous, { 'two words' as spaced, __proto__ as proto } from './names.js';\nreturn [anonymous(), anonymous.name, spaced, proto];\n",
    );
    await writeFile(join(folder, 'names.js'), "const value = 'v';\nexport { value as 'two words', value as __proto__ };\nexport default function () { return 'f'; }\n(0);\n");

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual((await runBuiltScript(result.script, {})).value, ['f', 'default', 'v', 'v']);
  });

  it('exports a parenthesized default value, and keeps a parenthesized class expression out of the module scope', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(
      join(folder, 'entry.js'),
      "export const meta = {};\nimport object from './object.js';\nimport run from './run.js';\nimport Exported, { isBound } from './named.js';\nimport three from './three.js';\nreturn [object.a, run(), run.name, Exported.name, isBound, three];\n",
    );
    await writeFile(join(folder, 'object.js'), 'export default ({ a: 1 });\n');
    await writeFile(join(folder, 'run.js'), 'export default (function () { return 2; });\n');
    await writeFile(join(folder, 'named.js'), "export default (class Named {});\nexport const isBound = typeof Named !== 'undefined';\n");
    await writeFile(join(folder, 'three.js'), 'export /* default */ default (\n  3\n)\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings, []);
    assert.deepEqual((await runBuiltScript(result.script, {})).value, [1, 2, 'default', 'Named', false, 3]);
  });

  it('keeps apart the statements around a removed import or export list, in code with no semicolons', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(
      join(folder, 'entry.js'),
      [
        'export const meta = {};',
        'const calls = [];',
        'const run = (value) => { calls.push(value); return run; };',
        "const f = () => 'f'",
        "run('a')",
        "import { g, items } from './lib.js'",
        ';[1].forEach(run)',
        "run('b')",
        "import './side.js';",
        '(f)',
        "const h = () => 'h'",
        "import './side.js'",
        '(h)',
        'return [calls, f(), h(), g(), items];',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(folder, 'lib.js'),
      "export const items = []\nconst g = function () { return 'g' }\nexport { g }\n(function () { items.push('iife') })()\nexport { items as list }\n;[2].forEach((item) => items.push(item))\n",
    );
    await writeFile(join(folder, 'side.js'), "log('side')\n");

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    const { value, logLines } = await runBuiltScript(result.script, {});

    assert.deepEqual(result.findings, []);
    assert.deepEqual(value, [['a', 1, 'b'], 'f', 'h', 'g', ['iife', 2]]);
    assert.deepEqual(logLines, ['side']);
    assert.ok(result.script.split('\n').includes(';[1].forEach(run)'));
  });

  it('reports a block comment that opens on the meta line and ends on a later line', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {}; /* note\n */\nimport { a } from './a.js';\nreturn a;\n");
    await writeFile(join(folder, 'a.js'), 'export const a = 1;\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.column]), [['meta-not-alone', 1, 25]]);
  });

  it('escapes a line terminator in a module path inside its comment line', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport { a } from './a\\u2028b.js';\nreturn a;\n");
    await writeFile(join(folder, 'a\u2028b.js'), 'export const a = 1;\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.ok(result.script.includes('// a\\u2028b.js\n'));
    assert.equal((await runBuiltScript(result.script, {})).value, 1);
  });

  it('reports a module that starts with a #! line, which cannot sit inside a script', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport './tool.js';\n");
    await writeFile(join(folder, 'tool.js'), '#!/usr/bin/env node\nlog(1);\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.column]), [['syntax-error', 1, 1]]);
  });

  it('freezes and tags a module namespace when the module declares its own Object and Symbol, and refuses an entry that does', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport * as shadow from './shadow.js';\nreturn [Object.isFrozen(shadow), shadow.keys, Object.prototype.toString.call(shadow)];\n");
    await writeFile(join(folder, 'shadow.js'), 'const Object = { freeze: () => null, defineProperty: () => null };\nconst Symbol = {};\nexport const keys = Object.freeze();\n');
    await writeFile(join(folder, 'shadowing-entry.js'), "export const meta = {};\nimport './shadow.js';\nif (true) { var Object = 1; }\nfunction Symbol() {}\n");

    const built = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    const refused = await build({ entry: join(folder, 'shadowing-entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual((await runBuiltScript(built.script, {})).value, [true, null, '[object Module]']);
    assert.deepEqual(refused.findings.map((finding) => [finding.rule, finding.line]), [['reserved-name', 3], ['reserved-name', 4]]);
  });

  it('gives a namespace import the toStringTag and the own keys of an ES module namespace', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(
      join(folder, 'entry.js'),
      "export const meta = {};\nimport * as values from './values.mjs';\nreturn [Object.prototype.toString.call(values), Object.getOwnPropertyDescriptor(values, Symbol.toStringTag), Reflect.ownKeys(values)];\n",
    );
    await writeFile(join(folder, 'values.mjs'), 'export const b = 2;\nexport const a = 1;\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    const namespace = await import(pathToFileURL(join(folder, 'values.mjs')).href);

    assert.deepEqual((await runBuiltScript(result.script, {})).value, [
      Object.prototype.toString.call(namespace),
      Object.getOwnPropertyDescriptor(namespace, Symbol.toStringTag),
      Reflect.ownKeys(namespace),
    ]);
  });

  it('allows code on the meta line of an entry that imports nothing', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {}; const value = 2;\nreturn value;\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.equal((await runBuiltScript(result.script, {})).value, 2);
  });

  it('reports a template literal that spans the meta line break of an entry with no import, unless the banner is off', async () => {
    const folder = await makeTemporaryFolder();
    const text = 'export const meta = {}; const p = `one\ntwo`;\nreturn p;\n';
    await writeFile(join(folder, 'entry.js'), text);

    const withBanner = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    const withoutBanner = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), banner: false, write: false });

    assert.deepEqual(withBanner.findings.map((finding) => [finding.rule, finding.line, finding.column]), [['meta-not-alone', 1, 36]]);
    assert.equal(withoutBanner.script, text);
  });

  it('reports an import of a folder, of a path with an encoded slash, and of the entry', async () => {
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'folder.js'));
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport './folder.js';\nimport './a%2Fb.js';\nimport './back.js';\n");
    await writeFile(join(folder, 'back.js'), "import './entry.js';\n");

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    const found = result.findings.map((finding) => `${finding.rule} ${finding.message}`);

    assert.deepEqual(found, [
      'import-not-found The specifier "./folder.js" names a folder',
      'import-not-found The specifier "./a%2Fb.js" names no file path',
      `import-cycle Modules import each other in a cycle: ${formatForwardSlashes(relative(process.cwd(), join(folder, 'entry.js')))} -> ${formatForwardSlashes(relative(process.cwd(), join(folder, 'back.js')))} -> ${formatForwardSlashes(relative(process.cwd(), join(folder, 'entry.js')))}`,
    ]);
  });
});

describe('build output and usage errors', () => {
  it('leaves an earlier built script in place when the build has a finding', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\nreturn 1;\n');
    await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js') });
    const earlier = await readFile(join(folder, 'out.js'), 'utf8');

    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport x from 'package';\n");
    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js') });

    assert.equal(result.ok, false);
    assert.equal(await readFile(join(folder, 'out.js'), 'utf8'), earlier);
    assert.deepEqual((await readdir(folder)).sort(), ['entry.js', 'out.js']);
  });

  it('creates the folder of out and leaves no temporary file', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\nreturn 1;\n');

    await build({ entry: join(folder, 'entry.js'), out: join(folder, 'dist', 'nested', 'out.js') });

    assert.deepEqual(await readdir(join(folder, 'dist', 'nested')), ['out.js']);
  });

  it('writes nothing with write: false', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\nreturn 1;\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'dist', 'out.js'), write: false });

    assert.equal(result.ok, true);
    assert.deepEqual(await readdir(folder), ['entry.js']);
  });

  it('rejects a missing entry, a missing out, an out that is a source, a folder or inside a file, and options of another shape', async () => {
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'dist'));
    await writeFile(join(folder, 'notes.txt'), 'notes\n');
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport { a } from './a.js';\nreturn a;\n");
    await writeFile(join(folder, 'a.js'), 'export const a = 1;\n');
    const entry = join(folder, 'entry.js');
    const isUsageError = (pattern) => (error) => error.name === 'UsageError' && pattern.test(error.message);

    await assert.rejects(build({ entry: join(folder, 'none.js'), out: join(folder, 'out.js') }), isUsageError(/does not exist/));
    await assert.rejects(build({ entry: folder, out: join(folder, 'out.js') }), isUsageError(/is not a file/));
    await assert.rejects(build({ entry }), isUsageError(/needs out/));
    await assert.rejects(build({ entry, out: entry }), isUsageError(/is a source/));
    await assert.rejects(build({ entry, out: join(folder, 'a.js') }), isUsageError(/is a source/));
    await assert.rejects(build({ entry, out: join(folder, 'dist') }), isUsageError(/is not a file/));
    await assert.rejects(build({ entry, out: join(folder, 'notes.txt', 'out.js') }), isUsageError(/is inside a file/));
    await assert.rejects(build({ entry, out: join(folder, 'notes.txt', 'deeper', 'out.js'), write: false }), isUsageError(/is inside a file/));
    await assert.rejects(build({ entry, out: join(folder, 'out.js'), banner: 'no' }), isUsageError(/banner/));
    await assert.rejects(build(null), isUsageError(/takes an options object/));
    await assert.rejects(build([entry]), isUsageError(/takes an options object/));
    await assert.rejects(build(entry), isUsageError(/takes an options object/));
    await assert.rejects(build({ entry, out: join(folder, 'out.js'), Write: false }), isUsageError(/takes no option Write$/));
    await assert.rejects(build({ entry, out: join(folder, 'out.js'), dryRun: true }), isUsageError(/takes no option dryRun$/));
    assert.deepEqual((await readdir(folder)).sort(), ['a.js', 'dist', 'entry.js', 'notes.txt']);
    assert.equal(await readFile(join(folder, 'a.js'), 'utf8'), 'export const a = 1;\n');
  });

  it('rejects an out on another drive than the entry while the banner is on', async (context) => {
    const folder = await makeTemporaryFolder();
    if (hasSameRoot(folder, FIXTURES)) return context.skip('the fixtures sit on the drive of the temporary folder');
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\nreturn 1;\n');
    const out = join(FIXTURES, 'never-written.js');

    await assert.rejects(build({ entry: join(folder, 'entry.js'), out, write: false }), (error) => error.name === 'UsageError' && /another drive/.test(error.message));
    assert.equal((await build({ entry: join(folder, 'entry.js'), out, banner: false, write: false })).ok, true);
  });

  it('reports import-not-found for a module that a link places on another drive than the entry', async (context) => {
    const folder = await makeTemporaryFolder();
    if (hasSameRoot(folder, FIXTURES)) return context.skip('the fixtures sit on the drive of the temporary folder');
    await symlink(join(FIXTURES, 'modules', 'lib'), join(folder, 'linked'), 'junction');
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport './linked/side-effect.js';\n");

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line]), [['import-not-found', 2]]);
    assert.match(result.findings[0].message, /another drive than the entry/);
  });

  it('evaluates a module that two different specifiers reach once', async () => {
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'lib'));
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport { count } from './lib/count.js';\nimport { again } from './lib/../lib/again.js';\nreturn [count, again];\n");
    await writeFile(join(folder, 'lib', 'count.js'), "log('count');\nexport const count = 1;\n");
    await writeFile(join(folder, 'lib', 'again.js'), "import { count } from '../lib/count.js';\nexport const again = count;\n");

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    const { value, logLines } = await runBuiltScript(result.script, {});

    assert.deepEqual(value, [1, 1]);
    assert.deepEqual(logLines, ['count']);
    assert.equal(result.sources.length, 3);
  });

  it('reports entry-export for an empty export list in the entry instead of a script that does not compile', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\nexport {};\nreturn 1;\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line]), [['entry-export', 2]]);
  });
});

describe('compileBuiltScript', () => {
  it('reports a built script that does not compile as a defect of the tool, with the syntax error as its cause', () => {
    const meta = 'export const meta = {};';

    assert.doesNotThrow(() => compileBuiltScript(`${meta}\nreturn 1;`, meta.length));
    assert.throws(
      () => compileBuiltScript(`${meta}\nexport {};`, meta.length),
      (error) => /^The built script does not compile, which is a defect in dynamic-workflow-bundler\. /.test(error.message) && error.cause instanceof SyntaxError,
    );
  });
});
