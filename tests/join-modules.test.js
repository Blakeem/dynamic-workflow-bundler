import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import { joinModules, nameSource } from '../src/join-modules.js';
import { linkModules } from '../src/link-modules.js';
import { loadSources } from '../src/load-sources.js';

const temporaryFolders = [];
after(async () => {
  for (const folder of temporaryFolders) await rm(folder, { recursive: true, force: true });
});

/**
 * Writes the files into a new folder and joins its `entry.js` as a build does.
 * @param {Record<string, string>} files
 * @param {boolean} hasBanner
 */
async function joinFiles(files, hasBanner) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'dwfb-join-')));
  temporaryFolders.push(folder);
  for (const [name, text] of Object.entries(files)) await writeFile(join(folder, name), text);
  const entryFile = join(folder, 'entry.js');
  const { sources, findings } = await loadSources(entryFile, hasBanner);
  const { order } = linkModules(sources, entryFile, (file) => file);
  const joinedSources = order.map((file) => ({ ...sources.get(file), path: relative(dirname(entryFile), file).split(sep).join('/') }));
  assert.deepEqual(findings, []);
  return joinModules({ entry: sources.get(entryFile), sources: joinedSources, bannerPath: hasBanner ? 'entry.js' : null });
}

/**
 * @param {import('../src/join-modules.js').LineOrigin} origin
 * @returns {string} `<file name>:<line>`, with `-` for no file and `+` for a line the build adds.
 */
function formatOrigin({ file, line }) {
  return `${file === null ? '-' : basename(file)}:${line ?? '+'}`;
}

describe('joinModules line origins', () => {
  it('maps each line of the script to its source line, or to the source of a line the build adds', async () => {
    const { script, lineOrigins } = await joinFiles(
      {
        'entry.js': "export const meta = {\n};\nimport { a } from './a.js';\nimport t from './t.md';\nimport j from './j.json';\n// @include ./part.js\nreturn [a, t, j, p];\n",
        'part.js': 'const p = 1;\n',
        'a.js': 'export const a = 1;\nconst unused = 2;\n',
        't.md': 'T1\nT2',
        'j.json': '{ "j": 1 }\n',
      },
      true,
    );

    assert.equal(lineOrigins.length, script.split('\n').length);
    assert.deepEqual(lineOrigins.map(formatOrigin), [
      'entry.js:1', 'entry.js:2', '-:+',
      't.md:+', 't.md:+', 't.md:1', 't.md:2',
      'j.json:+', 'j.json:+', 'j.json:1', 'j.json:+',
      'a.js:+', 'a.js:+', 'a.js:1', 'a.js:2', 'a.js:+',
      'entry.js:+', 'entry.js:3', 'entry.js:4', 'entry.js:5', 'part.js:1', 'entry.js:7', 'entry.js:8',
    ]);
    assert.equal(script.split('\n')[20], 'const p = 1;');
  });

  it('gives one origin per line with no banner and with an entry that ends without a line break', async () => {
    const { script, lineOrigins } = await joinFiles({ 'entry.js': "export const meta = {};\nimport { a } from './a.js';\nreturn a;", 'a.js': 'export const a = 1;' }, false);

    assert.equal(lineOrigins.length, script.split('\n').length);
    assert.deepEqual(lineOrigins.map(formatOrigin), ['entry.js:1', 'a.js:+', 'a.js:+', 'a.js:1', 'a.js:+', 'entry.js:+', 'entry.js:2', 'entry.js:3']);
  });

  it('gives the meta statement and the line after it to the entry when the entry is the meta statement alone', async () => {
    const { script, lineOrigins } = await joinFiles({ 'entry.js': 'export const meta = {};' }, true);

    assert.equal(script.split('\n').length, 3);
    assert.deepEqual(lineOrigins.map(formatOrigin), ['entry.js:1', '-:+', 'entry.js:2']);
  });
});

describe('joinModules source positions', () => {
  /**
   * @param {string} script
   * @param {string} lineText
   * @returns {number} The 1-based line of the script that holds the text.
   */
  function findScriptLine(script, lineText) {
    return script.split('\n').indexOf(lineText) + 1;
  }

  /**
   * @param {import('../src/join-modules.js').SourcePosition} position
   * @returns {object} The position with the file's name in place of its path.
   */
  function nameFile(position) {
    return { ...position, file: position.file === null ? null : basename(position.file) };
  }

  it('maps a column past an edit by the edit\'s change in length, and one inside an edit to its start', async () => {
    const { script, findSourcePosition } = await joinFiles(
      {
        'entry.js': "export const meta = {};\nimport { a } from './a.js';\nimport value from './d.js';\nreturn [a, value];\n",
        'a.js': 'export const a = 1;\n',
        'd.js': 'export default (2);\n',
      },
      false,
    );
    const exportLine = findScriptLine(script, 'const a = 1;');
    const defaultLine = script.split('\n').findIndex((line) => line.endsWith('= { default: (2) }.default;')) + 1;
    const defaultText = script.split('\n')[defaultLine - 1];

    assert.deepEqual(nameFile(findSourcePosition(exportLine, 1)), { file: 'a.js', line: 1, column: 8, text: 'export const a = 1;' });
    assert.equal(findSourcePosition(exportLine, 11).column, 18);
    assert.equal(findSourcePosition(defaultLine, 3).column, 1);
    assert.equal(findSourcePosition(defaultLine, defaultText.indexOf('(2)') + 1).column, 16);
    assert.equal(findSourcePosition(defaultLine, defaultText.indexOf(' }.default') + 1).column, 19);
    assert.equal(findSourcePosition(defaultLine, defaultText.length).column, 19);
  });

  it('maps each line of a removed multi-line import to its own source line', async () => {
    const { script, findSourcePosition } = await joinFiles(
      { 'entry.js': "export const meta = {};\nimport {\n  a,\n} from './a.js';\nreturn a;\n", 'a.js': 'export const a = 1;\n' },
      false,
    );
    const returnLine = findScriptLine(script, 'return a;');
    const importLines = [returnLine - 3, returnLine - 2, returnLine - 1];

    assert.deepEqual(importLines.map((line) => nameFile(findSourcePosition(line, 1))), [
      { file: 'entry.js', line: 2, column: 1, text: 'import {' },
      { file: 'entry.js', line: 3, column: 1, text: '  a,' },
      { file: 'entry.js', line: 4, column: 16, text: "} from './a.js';" },
    ]);
    assert.equal(findSourcePosition(returnLine - 1, 2).column, 17);
  });

  it('maps a column of a text file line past its escapes, and a column of a part line', async () => {
    const { script, findSourcePosition } = await joinFiles(
      {
        'entry.js': "export const meta = {};\nimport t from './t.md';\n// @include ./part.js\nreturn [t, p];\n",
        't.md': 'a`b${c}\\d\n',
        'part.js': 'const p =   1;\n',
      },
      false,
    );
    const textLine = findScriptLine(script, 'a\\`b\\${c}\\\\d');
    const partLine = findScriptLine(script, 'const p =   1;');

    assert.deepEqual(nameFile(findSourcePosition(textLine, 1)), { file: 't.md', line: 1, column: 1, text: 'a`b${c}\\d' });
    assert.deepEqual([3, 4, 6, 7, 10, 12, 13, 99].map((column) => findSourcePosition(textLine, column).column), [2, 3, 4, 4, 8, 9, 10, 10]);
    assert.deepEqual(nameFile(findSourcePosition(partLine, 13)), { file: 'part.js', line: 1, column: 13, text: 'const p =   1;' });
  });

  it('gives a line the build adds no column and no text', async () => {
    const { script, findSourcePosition } = await joinFiles({ 'entry.js': 'export const meta = {};\nreturn 1;\n' }, true);

    assert.match(script.split('\n')[1], /^\/\/ Built by dynamic-workflow-bundler/);
    assert.deepEqual(findSourcePosition(2, 1), { file: null, line: null, column: null, text: null });
  });
});

describe('nameSource', () => {
  it('names a source from its path, with the reserved prefix', () => {
    assert.match(nameSource('lib/join-modules.js'), /^__dwfb_lib_join_modules_js_[0-9a-f]{8}$/);
    assert.equal(nameSource('lib/a.js'), nameSource('lib/a.js'));
  });

  it('keeps apart paths that differ only in punctuation', () => {
    const names = ['lib/a-b.js', 'lib/a_b.js', 'lib/a.b.js', 'lib/a/b.js'].map(nameSource);
    assert.equal(new Set(names).size, names.length);
  });

  it('gives a valid identifier for a path outside the entry folder or with other letters', () => {
    for (const path of ['../shared/x.js', 'lib/ünicode.js', '__/x.mjs', 'prompts/review.md']) {
      assert.doesNotThrow(() => new Function(`const ${nameSource(path)} = 1;`));
    }
  });
});
