import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadSources } from '../src/load-sources.js';

const temporaryFolders = [];
after(async () => {
  for (const folder of temporaryFolders) await rm(folder, { recursive: true, force: true });
});

/**
 * @param {Record<string, string | Buffer>} texts Each file's text or bytes by its name.
 * @returns {Promise<string>} The real path of the folder.
 */
async function writeFolder(texts) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'dwfb-load-')));
  temporaryFolders.push(folder);
  for (const [name, text] of Object.entries(texts)) await writeFile(join(folder, name), text);
  return folder;
}

describe('loadSources', () => {
  it('reads the entry and each module once, as normalized text', async () => {
    const folder = await writeFolder({
      'entry.js': "export const meta = {};\r\nimport './a.js';\r\nimport './b.js';\r\n",
      'a.js': "﻿import './b.js';\r\n",
      'b.js': 'log(1);\n',
    });

    const { sources, findings } = await loadSources(join(folder, 'entry.js'), true);

    assert.deepEqual(findings, []);
    assert.deepEqual([...sources.keys()], ['entry.js', 'a.js', 'b.js'].map((name) => join(folder, name)));
    assert.equal(sources.get(join(folder, 'a.js')).text, "import './b.js';\n");
    assert.deepEqual(sources.get(join(folder, 'entry.js')).dependencies.map((dependency) => dependency.target), [join(folder, 'a.js'), join(folder, 'b.js')]);
  });

  it('reports import-not-found for a missing file and not for an existing one', async () => {
    const folder = await writeFolder({ 'entry.js': "export const meta = {};\nimport './none.js';\n", 'other.js': "export const meta = {};\nimport './a.js';\n", 'a.js': '' });

    const missing = await loadSources(join(folder, 'entry.js'), true);
    const present = await loadSources(join(folder, 'other.js'), true);

    assert.deepEqual(missing.findings.map((finding) => [finding.rule, finding.line]), [['import-not-found', 2]]);
    assert.deepEqual(present.findings, []);
  });

  it('reports source-encoding-invalid for an entry, a part and an imported file that are not valid UTF-8', async () => {
    const windows1252Text = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const folder = await writeFolder({
      'entry.js': "export const meta = {};\n// @include ./part.js\nimport note from './note.txt';\nimport './module.js';\nimport settings from './settings.json';\nlog(note, settings);\n",
      'other.js': Buffer.concat([Buffer.from("export const meta = {};\nlog('caf"), Buffer.from([0xe9]), Buffer.from("');\n")]),
      'part.js': Buffer.from('﻿log(1);\n', 'utf16le'),
      'note.txt': windows1252Text,
      'module.js': Buffer.concat([Buffer.from("log('"), windows1252Text, Buffer.from("');\n")]),
      'settings.json': Buffer.concat([Buffer.from('"'), Buffer.from([0xc3]), Buffer.from('"\n')]),
    });

    const imported = await loadSources(join(folder, 'entry.js'), true);
    const entry = await loadSources(join(folder, 'other.js'), true);

    assert.deepEqual(imported.findings.map((finding) => `${finding.rule} ${finding.line} ${finding.message}`), [
      'source-encoding-invalid 2 The path "./part.js" names a file that is not valid UTF-8',
      'source-encoding-invalid 3 The specifier "./note.txt" names a file that is not valid UTF-8',
      'source-encoding-invalid 4 The specifier "./module.js" names a file that is not valid UTF-8',
      'source-encoding-invalid 5 The specifier "./settings.json" names a file that is not valid UTF-8',
    ]);
    assert.deepEqual(imported.parts, []);
    assert.deepEqual([...imported.sources.keys()], [join(folder, 'entry.js')]);
    assert.deepEqual(entry.findings.map((finding) => [finding.rule, finding.line, finding.column]), [['source-encoding-invalid', 1, 1]]);
  });

  it('reports include-twice for each module import of a part, and not for a text file import of one', async () => {
    const folder = await writeFolder({
      'entry.js': "export const meta = {};\n// @include ./shared.js\n// @include ./quoted.js\nimport './shared.js';\nimport source from './quoted.js' with { type: 'text' };\nimport './helper.js';\n",
      'shared.js': 'log(1);\n',
      'quoted.js': 'log(2);\n',
      'helper.js': "import './shared.js';\n",
    });

    const { parts, findings } = await loadSources(join(folder, 'entry.js'), true);

    assert.deepEqual(findings.map((finding) => `${basename(finding.file)} ${finding.rule} ${finding.line} ${finding.message}`), [
      'entry.js include-twice 4 The specifier "./shared.js" names a part of the entry, so its code would run twice',
      'helper.js include-twice 1 The specifier "./shared.js" names a part of the entry, so its code would run twice',
    ]);
    assert.deepEqual(parts, [join(folder, 'shared.js'), join(folder, 'quoted.js')]);
  });

  it('reports import-not-found for a specifier with a malformed percent escape or an encoded NUL', async () => {
    const folder = await writeFolder({ 'entry.js': "export const meta = {};\nimport './100%.js';\nimport './a%00.js';\n" });

    const { findings } = await loadSources(join(folder, 'entry.js'), true);

    assert.deepEqual(findings.map((finding) => [finding.rule, finding.line]), [['import-not-found', 2], ['import-not-found', 3]]);
    assert.ok(findings.every((finding) => /names no file path/.test(finding.message)));
  });

  it('reports import-not-found for a specifier with a query or a fragment, and for one in another letter case', async () => {
    const folder = await writeFolder({
      'entry.js': "export const meta = {};\nimport './a.js?.js';\nimport './a.js#.js';\nimport './A.js';\nimport './a.js';\n",
      'a.js': '',
    });
    const isCaseInsensitive = await realpath(join(folder, 'A.js')).then(() => true, () => false);

    const { sources, findings } = await loadSources(join(folder, 'entry.js'), true);

    assert.deepEqual(findings.map((finding) => [finding.rule, finding.line]), [['import-not-found', 2], ['import-not-found', 3], ['import-not-found', 4]]);
    assert.match(findings[0].message, /holds a query or a fragment/);
    assert.match(findings[2].message, isCaseInsensitive ? /differs in letter case/ : /No file exists/);
    assert.deepEqual([...sources.keys()], [join(folder, 'entry.js'), join(folder, 'a.js')]);
  });

  it('reports include-not-found for a directive path with a backslash, a root or another letter case', async () => {
    const folder = await writeFolder({ 'part.js': 'log(1);\n' });
    await mkdir(join(folder, 'steps'));
    await writeFile(join(folder, 'steps', 'part.js'), 'log(2);\n');
    const absolutePart = join(folder, 'part.js').split('\\').join('/');
    await writeFile(
      join(folder, 'entry.js'),
      `export const meta = {};\n// @include .\\part.js\n// @include ${absolutePart}\n// @include C:part.js\n// @include ./Steps/part.js\n// @include ./PART.js\n// @include steps/part.js\n`,
    );
    const isCaseInsensitive = await realpath(join(folder, 'PART.js')).then(() => true, () => false);
    const otherCaseMessage = (path) => (isCaseInsensitive ? `The path "${path}" differs in letter case from the file it names` : `No file exists at "${path}"`);

    const { parts, findings } = await loadSources(join(folder, 'entry.js'), true);

    assert.deepEqual(findings.map((finding) => `${finding.rule} ${finding.line} ${finding.message}`), [
      'include-not-found 2 The path ".\\\\part.js" holds a backslash, which only Windows reads as a folder separator',
      `include-not-found 3 The path "${absolutePart}" is not relative to the entry's folder`,
      'include-not-found 4 The path "C:part.js" is not relative to the entry\'s folder',
      `include-not-found 5 ${otherCaseMessage('./Steps/part.js')}`,
      `include-not-found 6 ${otherCaseMessage('./PART.js')}`,
    ]);
    assert.deepEqual(parts, [join(folder, 'steps', 'part.js')]);
  });

  it('reads a module through a link whose stored target differs in letter case from its folder, and refuses a specifier that misspells the link', async (context) => {
    const folder = await writeFolder({ 'entry.js': "export const meta = {};\nimport './link/a.js';\n", 'other.js': "export const meta = {};\nimport './Link/a.js';\n" });
    await mkdir(join(folder, 'Real'));
    await writeFile(join(folder, 'Real', 'a.js'), '');
    await symlink(join(folder, 'real'), join(folder, 'link'), 'junction');
    const isCaseInsensitive = await realpath(join(folder, 'link', 'a.js')).then(() => true, () => false);
    if (!isCaseInsensitive) return context.skip('this file system is case sensitive');

    const linked = await loadSources(join(folder, 'entry.js'), true);
    const misspelled = await loadSources(join(folder, 'other.js'), true);

    assert.deepEqual(linked.findings, []);
    assert.deepEqual(misspelled.findings.map((finding) => [finding.rule, finding.line]), [['import-not-found', 2]]);
    assert.match(misspelled.findings[0].message, /differs in letter case/);
  });

  it('reads a module in a folder that may be passed through but not listed', async (context) => {
    if (process.platform === 'win32') return context.skip('Windows ignores the read permission of a folder');
    if (process.getuid?.() === 0) return context.skip('root lists every folder');
    const folder = await writeFolder({ 'entry.js': "export const meta = {};\nimport './locked/a.js';\n" });
    await mkdir(join(folder, 'locked'));
    await writeFile(join(folder, 'locked', 'a.js'), '');
    await chmod(join(folder, 'locked'), 0o311);

    try {
      const { findings } = await loadSources(join(folder, 'entry.js'), true);
      assert.deepEqual(findings, []);
    } finally {
      await chmod(join(folder, 'locked'), 0o755);
    }
  });

  it('reports import-not-found for a Windows short name of a module that another import names by its long name', async (context) => {
    const folder = await writeFolder({
      'entry.js': "export const meta = {};\nimport './longfilename-module.js';\nimport './lib/reader.js';\n",
      'longfilename-module.js': '',
    });
    const shortName = basename(readShortPath(join(folder, 'longfilename-module.js'))).toLowerCase();
    if (shortName === '' || shortName === 'longfilename-module.js') return context.skip('this volume has no short names');
    await mkdir(join(folder, 'lib'));
    await writeFile(join(folder, 'lib', 'reader.js'), `import '../${shortName}';\n`);

    const { sources, findings } = await loadSources(join(folder, 'entry.js'), true);

    assert.deepEqual(findings.map((finding) => [finding.rule, finding.file, finding.line]), [['import-not-found', join(folder, 'lib', 'reader.js'), 1]]);
    assert.match(findings[0].message, /already read under another path/);
    assert.equal(sources.size, 3);
  });

  it('resolves an import against the loader path of its importer, as the Node.js module loader does', async (context) => {
    const folder = await writeFolder({ 'entry.js': '' });
    await mkdir(join(folder, 'longfolder-name'));
    const shortFolder = basename(readShortPath(join(folder, 'longfolder-name'))).toLowerCase();
    if (shortFolder === '' || shortFolder === 'longfolder-name') return context.skip('this volume has no short names');
    await writeFile(join(folder, 'entry.js'), `export const meta = {};\nimport './${shortFolder}/first.js';\nimport './longfolder-name/second.js';\n`);
    await writeFile(join(folder, 'longfolder-name', 'first.js'), "import './second.js';\n");
    await writeFile(join(folder, 'longfolder-name', 'second.js'), '');

    const { findings } = await loadSources(join(folder, 'entry.js'), true);

    assert.deepEqual(findings.map((finding) => [finding.rule, finding.file, finding.line]), [['import-not-found', join(folder, 'entry.js'), 3]]);
  });

  it('reads an entry whose path is spelled with a lowercase drive letter without a letter case finding', async (context) => {
    const folder = await writeFolder({ 'entry.js': "export const meta = {};\nimport './a.js';\n", 'a.js': '' });
    if (!/^[A-Z]:/.test(folder)) return context.skip('the path has no drive letter');

    const { findings } = await loadSources(join(folder[0].toLowerCase() + folder.slice(1), 'entry.js'), true);

    assert.deepEqual(findings, []);
  });
});

/**
 * @param {string} path An existing file or folder.
 * @returns {string} Its Windows short path, or '' on another platform.
 */
function readShortPath(path) {
  if (process.platform !== 'win32') return '';
  const command = `"for %I in ("${path}") do @echo %~sI"`;
  return execFileSync('cmd.exe', ['/d', '/s', '/c', command], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
}
