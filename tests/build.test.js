import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse as parsePath, relative, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { build } from 'dynamic-workflow-bundler';
import { compileBuiltScript } from '../src/build.js';
import { FIXES } from '../src/finding.js';
import { READ_BYTE_LIMIT } from '../src/read-byte-limit.js';
import { runBuiltScript } from './support/run-built-script.js';
import { writeSizedFile } from './support/write-sized-file.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const MODULES_ENTRY = join(FIXTURES, 'modules', 'entry.js');

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
    { rule: 'source-too-deep', file: 'deep.js', line: 1 },
    { rule: 'meta-not-first', file: 'entry.js', line: 1 },
    { rule: 'meta-not-alone', file: 'entry.js', line: 1 },
    { rule: 'meta-reads-import', file: 'entry.js', line: 2 },
    { rule: 'entry-export', file: 'entry.js', line: 2 },
    { rule: 'import-not-relative', file: 'entry.js', line: 2 },
    { rule: 'import-not-default', file: 'entry.js', line: 2 },
    { rule: 'import-not-default', file: 'entry.js', line: 3 },
    { rule: 'import-not-default', file: 'entry.js', line: 4 },
    { rule: 'import-attribute-unknown', file: 'entry.js', line: 2 },
    { rule: 'import-attribute-unknown', file: 'entry.js', line: 3 },
    { rule: 'import-ending-unknown', file: 'entry.js', line: 2 },
    { rule: 'import-ending-unknown', file: 'entry.js', line: 3 },
    { rule: 'import-ending-unknown', file: 'entry.js', line: 4 },
    { rule: 'import-not-found', file: 'entry.js', line: 2 },
    { rule: 'import-kind-conflict', file: 'entry.js', line: 3 },
    { rule: 'source-encoding-invalid', file: 'entry.js', line: 2 },
    { rule: 'json-invalid', file: 'settings.json', line: 4 },
    { rule: 'include-not-found', file: 'entry.js', line: 2 },
    { rule: 'include-misplaced', file: 'entry.js', line: 1 },
    { rule: 'include-misplaced', file: 'entry.js', line: 5 },
    { rule: 'include-misplaced', file: 'entry.js', line: 7 },
    { rule: 'include-misplaced', file: 'part.js', line: 2 },
    { rule: 'include-misplaced', file: 'helper.js', line: 1 },
    { rule: 'include-twice', file: 'entry.js', line: 3 },
    { rule: 'include-twice', file: 'entry.js', line: 4 },
    { rule: 'include-twice', file: 'entry.js', line: 6 },
    { rule: 'part-not-plain', file: 'broken.js', line: 1 },
    { rule: 'part-not-plain', file: 'module.js', line: 1 },
    { rule: 'part-not-plain', file: 'module.js', line: 2 },
    { rule: 'statement-crosses-part', file: 'next.js', line: 1 },
    { rule: 'import-not-exported', file: 'entry.js', line: 2 },
    { rule: 'import-cycle', file: 'second.js', line: 1 },
    { rule: 'import-dynamic', file: 'entry.js', line: 2 },
    { rule: 'import-meta', file: 'location.js', line: 1 },
    { rule: 'export-not-constant', file: 'state.js', line: 1 },
    { rule: 'export-not-constant', file: 'state.js', line: 6 },
    { rule: 'export-from', file: 'barrel.js', line: 1 },
    { rule: 'module-top-level-await', file: 'ready.js', line: 1 },
    { rule: 'module-top-level-return', file: 'ready.js', line: 2 },
    { rule: 'module-top-level-this', file: 'context.js', line: 1 },
    { rule: 'module-top-level-this', file: 'context.js', line: 2 },
    { rule: 'module-top-level-this', file: 'context.js', line: 11 },
    { rule: 'module-top-level-arguments', file: 'context.js', line: 4 },
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

  it('reports source-too-large alone for an entry larger than READ_BYTE_LIMIT, and writes nothing', async () => {
    const folder = await makeTemporaryFolder();
    const entry = join(folder, 'entry.js');
    await writeSizedFile(entry, READ_BYTE_LIMIT + 1);
    const entryPath = formatForwardSlashes(relative(await realpath(process.cwd()), await realpath(entry)));

    const result = await build({ entry, out: join(folder, 'out.js') });

    assert.deepEqual(result, {
      ok: false,
      status: 'failed',
      script: null,
      sources: [entryPath],
      findings: [{
        rule: 'source-too-large',
        message: `The entry is ${READ_BYTE_LIMIT + 1} bytes, which is more than the ${READ_BYTE_LIMIT} bytes dwfb reads`,
        fix: FIXES['source-too-large'],
        file: entryPath,
        line: 1,
        column: 1,
      }],
    });
    assert.ok(!(await readdir(folder)).includes('out.js'));
  });

  it('builds a script of READ_BYTE_LIMIT bytes, and reports script-too-large alone on the entry for one byte more', async () => {
    const folder = await makeTemporaryFolder();
    const entry = join(folder, 'entry.js');
    const out = join(folder, 'out.js');
    await writeFile(entry, "export const meta = {};\nimport notes from './notes.txt';\nreturn notes;\n");
    await writeFile(join(folder, 'notes.txt'), '');
    const emptyScript = (await build({ entry, out, write: false })).script;
    const workFolder = await realpath(process.cwd());
    const entryPath = formatForwardSlashes(relative(workFolder, await realpath(entry)));
    const notesPath = formatForwardSlashes(relative(workFolder, await realpath(join(folder, 'notes.txt'))));

    await writeFile(join(folder, 'notes.txt'), 'a'.repeat(READ_BYTE_LIMIT - Buffer.byteLength(emptyScript)));
    const limitResult = await build({ entry, out, write: false });
    await writeFile(join(folder, 'notes.txt'), 'a'.repeat(READ_BYTE_LIMIT - Buffer.byteLength(emptyScript) + 1));
    const largeResult = await build({ entry, out });

    assert.equal(Buffer.byteLength(limitResult.script), READ_BYTE_LIMIT);
    assert.equal(limitResult.status, 'built');
    assert.deepEqual(largeResult, {
      ok: false,
      status: 'failed',
      script: null,
      sources: [entryPath, notesPath],
      findings: [{
        rule: 'script-too-large',
        message: `The built script is ${READ_BYTE_LIMIT + 1} bytes, which is more than the 524288 bytes the runtime reads`,
        fix: FIXES['script-too-large'],
        file: entryPath,
        line: 1,
        column: 1,
      }],
    });
    assert.ok(!(await readdir(folder)).includes('out.js'));
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

describe('build of text files, JSON files and parts', () => {
  it('imports a text file as its exact content, with each of its lines on a line of the built script', async () => {
    const folder = await makeTemporaryFolder();
    const prompt = "Review `this` change.\nKeep ${literal} and \\n as written.\nimport { nothing } from './nowhere.js';\n// @include ./part.js\nNo line break at the end";
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport prompt from './prompt.md';\nimport again from './prompt.md';\nreturn [prompt, again];\n");
    await writeFile(join(folder, 'prompt.md'), prompt);

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    const builtLines = result.script.split('\n');
    const firstLine = builtLines.indexOf('// prompt.md') + 2;

    assert.deepEqual(result.findings, []);
    assert.deepEqual((await runBuiltScript(result.script, {})).value, [prompt, prompt]);
    assert.equal(result.script.split('// prompt.md\n').length, 2);
    assert.equal(builtLines[firstLine], 'Review \\`this\\` change.');
    assert.equal(builtLines[firstLine + 2], "import { nothing } from './nowhere.js';");
    assert.equal(builtLines[firstLine + 4], 'No line break at the end`;');
  });

  it('drops a byte order mark and reads CRLF as LF in a text file, and keeps a lone CR', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport notes from './notes.txt';\nimport empty from './empty.txt' with { type: 'text' };\nreturn [notes, empty];\n");
    await writeFile(join(folder, 'notes.txt'), '﻿one\r\ntwo\rthree\n');
    await writeFile(join(folder, 'empty.txt'), '');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual((await runBuiltScript(result.script, {})).value, ['one\ntwo\rthree\n', '']);
  });

  it('gives every importer of a JSON file one object, equal to what JSON.parse gives', async () => {
    const folder = await makeTemporaryFolder();
    const json = '{\n  "name": "review",\n  "limits": [1, 2.5, -3e2],\n  "__proto__": { "own": true },\n  "text": "a`b${c}\\\\d"\n}\n';
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport { first } from './first.js';\nimport { second } from './second.js';\nimport settings from './settings.json';\nreturn [first === second, first === settings, settings];\n");
    await writeFile(join(folder, 'first.js'), "import settings from './settings.json';\nexport const first = settings;\n");
    await writeFile(join(folder, 'second.js'), "import data from './settings.json' with { type: 'json' };\nexport const second = data;\n");
    await writeFile(join(folder, 'settings.json'), json);

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    const [isShared, isEntryShared, settings] = (await runBuiltScript(result.script, {})).value;

    assert.deepEqual(result.findings, []);
    assert.equal(isShared, true);
    assert.equal(isEntryShared, true);
    assert.deepEqual(settings, JSON.parse(json));
    assert.equal(Object.hasOwn(settings, '__proto__'), true);
    assert.equal(result.script.split('// settings.json\n').length, 2);
    assert.ok(result.script.indexOf('// settings.json') < result.script.indexOf('// first.js'));
  });

  it('builds an entry of meta and directives over parts cut at statement boundaries to the original bytes', async () => {
    const folder = await makeTemporaryFolder();
    const original = [
      'export const meta = {',
      "  name: 'cut',",
      '};',
      '',
      'const steps = [];',
      'function step(name) { steps.push(name); return name }',
      '',
      "const prompt = `First line.",
      '// @include ./not-a-part.js',
      'Last line.`',
      "step('one')",
      ';[2, 3].forEach((n) => step(n))',
      'if (args.stop) return steps;',
      'const done = await agent(prompt);',
      'return [steps, done, prompt];',
    ].join('\n');
    const program = parse(original, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
    const lineStarts = program.body.map((statement) => original.slice(0, statement.start).split('\n').length - 1);
    const lines = original.split('\n');
    const metaLineCount = lineStarts[1];
    const cuts = [metaLineCount, lineStarts[2], lineStarts[4], lineStarts[6], lines.length];
    const directives = [];
    for (let index = 0; index < cuts.length - 1; index += 1) {
      await writeFile(join(folder, `part-${index + 1}.js`), lines.slice(cuts[index], cuts[index + 1]).join('\r\n'));
      directives.push(`// @include ./part-${index + 1}.js`);
    }
    await writeFile(join(folder, 'entry.js'), `﻿${[...lines.slice(0, metaLineCount), ...directives].join('\r\n')}`);

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), banner: false });
    const written = await readFile(join(folder, 'out.js'), 'utf8');

    assert.deepEqual(result.findings, []);
    assert.equal(written, `${original}\n`);
    assert.deepEqual(result.sources.map((file) => file.split('/').at(-1)), ['entry.js', 'part-1.js', 'part-2.js', 'part-3.js', 'part-4.js']);
    assert.deepEqual((await runBuiltScript(written, { stop: true })).value, ['one', 2, 3]);
  });

  it('puts each part line byte for byte in the built script, and lists every text file, JSON file and part', async () => {
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'parts'));
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport { label } from './label.js';\n// @include parts/setup.js\nreturn [label, notes, count];\n");
    await writeFile(join(folder, 'label.js'), "import settings from './settings.json';\nexport const label = settings.label;\n");
    await writeFile(join(folder, 'settings.json'), '{ "label": "L" }\n');
    await writeFile(join(folder, 'parts', 'setup.js'), "  const notes = (await readNotes());\n\tconst count = 2; // a comment\nasync function readNotes() { return 'N'; }\n");

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    const partLines = ['  const notes = (await readNotes());', '\tconst count = 2; // a comment', "async function readNotes() { return 'N'; }"];
    const builtLines = result.script.split('\n');
    const partStart = builtLines.indexOf(partLines[0]);

    assert.deepEqual(result.findings, []);
    assert.deepEqual(builtLines.slice(partStart, partStart + 3), partLines);
    assert.deepEqual((await runBuiltScript(result.script, {})).value, ['L', 'N', 2]);
    assert.deepEqual(result.sources.map((file) => file.split('/').at(-1)), ['entry.js', 'setup.js', 'label.js', 'settings.json']);
  });

  it('reports a finding in a part at the part\'s line, and an entry finding below a part at the entry\'s line', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\n// @include ./part.js\nconst ok = 2;\n');
    await writeFile(join(folder, 'part.js'), 'log(1);\nconst ok = 1;\n');
    await writeFile(join(folder, 'clean.js'), "export const meta = {};\n// @include ./clean-part.js\nconst __dwfb_entry = 1;\nimport './missing.js';\n");
    await writeFile(join(folder, 'clean-part.js'), 'const ok = import.meta;\nconst __dwfb_part = 2;\n');

    const redeclared = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });
    const result = await build({ entry: join(folder, 'clean.js'), out: join(folder, 'out.js'), write: false });
    const listFindings = (findings) => findings.map((finding) => `${finding.rule} ${finding.file.split('/').at(-1)}:${finding.line}:${finding.column}`);

    assert.deepEqual(listFindings(redeclared.findings), ['syntax-error entry.js:3:7']);
    assert.deepEqual(listFindings(result.findings), [
      'reserved-name clean.js:3:7',
      'import-not-found clean.js:4:8',
      'import-meta clean-part.js:1:12',
      'reserved-name clean-part.js:2:7',
    ]);
  });

  it('reports source-too-deep in a part at the deep code\'s line in the part', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\n// @include ./part.js\nreturn v;\n');
    await writeFile(join(folder, 'part.js'), `const a = { b: 1 };\nconst v = typeof a${'.b'.repeat(20000)};\n`);

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings.map((finding) => `${finding.rule} ${finding.file.split('/').at(-1)}:${finding.line}:${finding.column}`), ['source-too-deep part.js:2:18']);
  });

  it('reports an import that reads a text file of this build as a module', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport source from './a.js' with { type: 'text' };\nimport { a } from './a.js';\nreturn [a, source];\n");
    await writeFile(join(folder, 'a.js'), 'export const a = 1;\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings.map((finding) => `${finding.rule} ${finding.line} ${finding.message}`), [
      'import-kind-conflict 3 The specifier "./a.js" names a text file of this build, which this import reads as a module',
    ]);
  });

  it('builds an entry that imports only text files and declares Object, Symbol and JSON', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport prompt from './prompt.md';\nconst Object = 1;\nclass Symbol {}\nconst JSON = 2;\nreturn [prompt, Object, JSON];\n");
    await writeFile(join(folder, 'prompt.md'), 'p');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings, []);
    assert.deepEqual((await runBuiltScript(result.script, {})).value, ['p', 1, 2]);
  });

  it('reports include-not-found for a folder, an empty path and a NUL, and refuses an out that is a part', async () => {
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'folder.js'));
    await writeFile(join(folder, 'part.js'), 'log(1);\n');
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\n// @include ./folder.js\n// @include\n// @include ./a\0b.js\n');
    await writeFile(join(folder, 'with-part.js'), 'export const meta = {};\n// @include ./part.js\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings.map((finding) => `${finding.rule} ${finding.line} ${finding.message}`), [
      'include-not-found 2 The path "./folder.js" names a folder',
      'include-not-found 3 The directive names no path',
      'include-not-found 4 The path "./a\\u0000b.js" holds a NUL character',
    ]);
    await assert.rejects(build({ entry: join(folder, 'with-part.js'), out: join(folder, 'part.js') }), (error) => error.name === 'UsageError' && /is a source/.test(error.message));
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

  it('binds an import of the string export name "*" to that export, and a namespace import to the namespace', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport { '*' as star } from './star.js';\nimport * as all from './star.js';\nreturn [star, Object.keys(all)];\n");
    await writeFile(join(folder, 'star.js'), "const a = 1;\nexport { a as '*' };\nexport const other = 2;\n");

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings, []);
    assert.deepEqual((await runBuiltScript(result.script, {})).value, [1, ['*', 'other']]);
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

  it('rejects a missing entry, a missing out, an out that is a source, a folder or inside a file, a path that ends in a separator, . or .., and options of another shape', async () => {
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
    await assert.rejects(build({ entry, out: join(folder, 'dist') + sep }), isUsageError(/names a folder\. Name the built script's file in it$/));
    await assert.rejects(build({ entry, out: join(folder, 'new') + sep }), isUsageError(/names a folder\. Name the built script's file in it$/));
    await assert.rejects(build({ entry, out: `${folder}/new/` }), isUsageError(/names a folder\. Name the built script's file in it$/));
    await assert.rejects(build({ entry: entry + sep, out: join(folder, 'out.js') }), isUsageError(/is not a file$/));
    await assert.rejects(build({ entry, out: `${folder}/new/.` }), isUsageError(/names a folder\. Name the built script's file in it$/));
    await assert.rejects(build({ entry, out: `${folder}/new/deeper/..` }), isUsageError(/names a folder\. Name the built script's file in it$/));
    await assert.rejects(build({ entry: `${entry}/.`, out: join(folder, 'out.js') }), isUsageError(/is not a file$/));
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

  it('reports include-not-found for a part that a link places on another drive than the entry', async (context) => {
    const folder = await makeTemporaryFolder();
    if (hasSameRoot(folder, FIXTURES)) return context.skip('the fixtures sit on the drive of the temporary folder');
    await symlink(join(FIXTURES, 'modules', 'lib'), join(folder, 'linked'), 'junction');
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\n// @include ./linked/side-effect.js\n');

    const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out.js'), write: false });

    assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line]), [['include-not-found', 2]]);
    assert.match(result.findings[0].message, /another drive than the entry/);
  });

  it('names a module behind a linked folder by its real path in the path comment', async (context) => {
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'project'));
    await mkdir(join(folder, 'shared'));
    await writeFile(join(folder, 'shared', 'm.js'), 'export const m = 1;\n');
    await writeFile(join(folder, 'project', 'entry.js'), "export const meta = {};\nimport { m } from './lib/m.js';\nreturn m;\n");
    try {
      await symlink(join(folder, 'shared'), join(folder, 'project', 'lib'), 'junction');
    } catch (error) {
      return context.skip(`the test process cannot create a link: ${error.code}`);
    }

    const result = await build({ entry: join(folder, 'project', 'entry.js'), out: join(folder, 'project', 'out.js'), write: false });

    assert.ok(result.script.split('\n').includes('// ../shared/m.js'));
    assert.equal(result.script.includes('// lib/m.js'), false);
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

describe('build check', () => {
  /**
   * Writes an entry with a part, a module, a text file and a JSON file, builds it, and returns its paths.
   * @returns {Promise<{ folder: string, entry: string, out: string }>}
   */
  async function writeBuiltProject() {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport { a } from './a.js';\nimport notes from './notes.md';\nimport settings from './settings.json';\n// @include ./part.js\nreturn [a, notes, settings, p];\n");
    await writeFile(join(folder, 'part.js'), 'const p = 1;\nconst q = 2;\n');
    await writeFile(join(folder, 'a.js'), 'export const a = 1;\nconst b = 2;\n');
    await writeFile(join(folder, 'notes.md'), 'first\nsecond\n');
    await writeFile(join(folder, 'settings.json'), '{ "s": 1 }\n');
    const entry = join(folder, 'entry.js');
    const out = join(folder, 'out.js');
    await build({ entry, out });
    return { folder, entry, out };
  }

  /**
   * @param {string} folder
   * @param {string} name
   * @returns {string} The path as a build reports it.
   */
  function formatPath(folder, name) {
    return formatForwardSlashes(relative(process.cwd(), join(folder, name)));
  }

  it('finds a fresh script and writes nothing', async () => {
    const { folder, entry, out } = await writeBuiltProject();
    const before = await readFile(out);

    const result = await build({ entry, out, check: true });

    assert.equal(result.status, 'fresh');
    assert.equal(result.ok, true);
    assert.equal(result.firstDifference, undefined);
    assert.ok((await readFile(out)).equals(before));
    assert.deepEqual((await readdir(folder)).sort(), ['a.js', 'entry.js', 'notes.md', 'out.js', 'part.js', 'settings.json']);
  });

  it('maps the first differing line to the edited source and line, for each kind of source', async () => {
    const { folder, entry, out } = await writeBuiltProject();
    const realFolder = await realpath(folder);
    const edits = [
      { name: 'part.js', text: 'const p = 1;\nconst q = 3;\n', sourceLine: 2 },
      { name: 'a.js', text: 'export const a = 1;\nconst b = 3;\n', sourceLine: 2 },
      { name: 'notes.md', text: 'first\nsecond line\n', sourceLine: 2 },
      { name: 'settings.json', text: '{ "s": 2 }\n', sourceLine: 1 },
      { name: 'entry.js', text: "export const meta = { name: 'x' };\nimport { a } from './a.js';\nimport notes from './notes.md';\nimport settings from './settings.json';\n// @include ./part.js\nreturn [a, notes, settings, p];\n", sourceLine: 1 },
    ];

    for (const { name, text, sourceLine } of edits) {
      const original = await readFile(join(folder, name), 'utf8');
      await writeFile(join(folder, name), text);
      const result = await build({ entry, out, check: true });
      const builtLines = result.script.split('\n');
      await writeFile(join(folder, name), original);

      assert.equal(result.status, 'stale', name);
      assert.equal(result.ok, false, name);
      assert.deepEqual(result.firstDifference, { line: builtLines.indexOf(text.split('\n')[sourceLine - 1]) + 1, file: formatPath(realFolder, name), sourceLine }, name);
    }
  });

  it('gives no source line for a line the build adds, and the source of its constant or scope', async () => {
    const { folder, entry, out } = await writeBuiltProject();
    const realFolder = await realpath(folder);
    const script = await readFile(out, 'utf8');
    const lines = script.split('\n');
    const scopeLine = lines.findIndex((line) => line.startsWith('return { __proto__: null'));
    const bannerLine = lines.findIndex((line) => line.startsWith('// Built by dynamic-workflow-bundler'));

    await writeFile(out, lines.map((line, index) => (index === scopeLine ? `${line} ` : line)).join('\n'));
    const scopeResult = await build({ entry, out, check: true });
    await writeFile(out, lines.map((line, index) => (index === bannerLine ? `${line} ` : line)).join('\n'));
    const bannerResult = await build({ entry, out, check: true });

    assert.deepEqual(scopeResult.firstDifference, { line: scopeLine + 1, file: formatPath(realFolder, 'a.js'), sourceLine: null });
    assert.deepEqual(bannerResult.firstDifference, { line: bannerLine + 1, file: null, sourceLine: null });
  });

  it('finds a script with other line endings, extra lines or a missing last byte stale, the built script fresh, and a missing script missing', async () => {
    const { folder, entry, out } = await writeBuiltProject();
    const script = await readFile(out, 'utf8');
    const lastLine = script.split('\n').length;

    await writeFile(out, script.replaceAll('\n', '\r\n'));
    const crlf = await build({ entry, out, check: true });
    await writeFile(out, `${script}// more\n`);
    const longer = await build({ entry, out, check: true });
    await writeFile(out, `${script}${'x'.repeat(READ_BYTE_LIMIT)}`);
    const muchLonger = await build({ entry, out, check: true });
    await writeFile(out, script.slice(0, -1));
    const shorter = await build({ entry, out, check: true });
    await writeFile(out, script);
    const fresh = await build({ entry, out, check: true });
    await rm(out);
    const missing = await build({ entry, out, check: true });

    assert.equal(crlf.firstDifference.line, 1);
    assert.deepEqual(longer.firstDifference, { line: lastLine, file: formatPath(await realpath(folder), 'entry.js'), sourceLine: 7 });
    assert.deepEqual(muchLonger.firstDifference, longer.firstDifference);
    assert.equal(shorter.firstDifference.line, lastLine - 1);
    assert.equal(fresh.status, 'fresh');
    assert.deepEqual({ ok: missing.ok, status: missing.status, firstDifference: missing.firstDifference }, { ok: false, status: 'missing', firstDifference: undefined });
    assert.equal(crlf.ok, false);
    assert.equal((await readdir(folder)).includes('out.js'), false);
  });

  it('gives failed for a source with a finding, written or built otherwise', async () => {
    const { folder, entry, out } = await writeBuiltProject();

    assert.equal((await build({ entry, out })).status, 'written');
    assert.equal((await build({ entry, out, write: false })).status, 'built');
    await writeFile(join(folder, 'a.js'), 'export let a = 1;\n');
    assert.equal((await build({ entry, out, check: true })).status, 'failed');
    assert.equal((await build({ entry, out })).status, 'failed');
  });

  it('rejects check that is not a boolean, and check with write: true', async () => {
    const { entry, out } = await writeBuiltProject();
    const isUsageError = (pattern) => (error) => error.name === 'UsageError' && pattern.test(error.message);

    await assert.rejects(build({ entry, out, check: 'yes' }), isUsageError(/^build\(\) takes check as a boolean$/));
    await assert.rejects(build({ entry, out, check: true, write: true }), isUsageError(/^build\(\) writes nothing with check, so it takes no write: true$/));
    assert.equal((await build({ entry, out, check: true, write: false })).status, 'fresh');
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
