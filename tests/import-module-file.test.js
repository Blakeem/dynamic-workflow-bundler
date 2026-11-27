import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { importCheckedDefault, importModuleFile } from '../src/import-module-file.js';
import { UsageError } from '../src/usage-error.js';

const LABEL = 'The data file d.js';
const RECOVERY = 'rename it to d.mjs';
const folder = await mkdtemp(join(tmpdir(), 'dwfb-import-'));
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

/**
 * @param {string} path Relative to the test's folder.
 * @param {string} text
 * @returns {Promise<string>} The file's absolute path.
 */
async function writeTestFile(path, text) {
  const file = join(folder, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text);
  return file;
}

/**
 * @param {string} file
 * @param {RegExp} pattern
 */
async function assertUsageError(file, pattern) {
  await assert.rejects(importModuleFile(file, LABEL, RECOVERY), (error) => error.name === 'UsageError' && pattern.test(error.message));
}

describe('importModuleFile', () => {
  it('gives the module namespace of an ES module', async () => {
    const file = await writeTestFile('module/d.mjs', 'export default [1];\nexport const name = "d";\n');

    const loadedModule = await importModuleFile(file, LABEL, RECOVERY);

    assert.deepEqual({ ...loadedModule }, { default: [1], name: 'd' });
  });

  it('opens each message with the label it takes', async () => {
    const throwing = await writeTestFile('module/throws.mjs', "throw new Error('Not ready');\n");
    await mkdir(join(folder, 'folder.mjs'));

    await assertUsageError(join(folder, 'missing.mjs'), /^The data file d\.js does not exist$/);
    await assertUsageError(join(folder, 'folder.mjs'), /^The data file d\.js is not a file$/);
    await assertUsageError(throwing, /^The data file d\.js does not load\. Not ready$/);
  });

  it('names the file and line of a syntax error in the file or a module it imports', async () => {
    const broken = await writeTestFile('module/broken.mjs', 'export default [\n  1,,,\n');
    const importing = await writeTestFile('module/importing.mjs', "import './broken.mjs';\nexport default [];\n");

    await assertUsageError(broken, /^The data file d\.js does not load\. [^\n]*module\/broken\.mjs:3:1 Unexpected token$/);
    await assertUsageError(importing, /^The data file d\.js does not load\. [^\n]*module\/broken\.mjs:3:1 Unexpected token$/);
  });

  it('names the recovery it takes for a file with module syntax that Node loads as CommonJS, and the fixed one for a file it imports', async () => {
    await writeTestFile('commonjs/package.json', '{ "type": "commonjs" }\n');
    const own = await writeTestFile('commonjs/own.js', 'export default [];\n');
    await writeTestFile('commonjs/imported.js', 'export const a = 1;\n');
    const importing = await writeTestFile('commonjs/importing.mjs', "import './imported.js';\nexport default [];\n");

    await assertUsageError(own, /^The data file d\.js does not load\. Unexpected token 'export'\. If the file is an ES module, set "type": "module" in the nearest package\.json, or rename it to d\.mjs$/);
    await assertUsageError(importing, /^The data file d\.js does not load\. [^\n]*commonjs\/imported\.js:1:1 [^\n]*\. If the file is an ES module, set "type": "module" in the nearest package\.json, or rename it to a \.mjs file$/);
  });

  const otherPlatform = process.platform === 'win32' ? false : 'the stored letter case of a path was probed on Windows only';
  it('loads one module for two spellings of its path that differ in letter case', { skip: otherPlatform }, async () => {
    const file = await writeTestFile('case/count.mjs', 'let count = 0;\nexport default () => (count += 1);\n');
    const otherSpelling = join(folder, 'CASE', 'COUNT.mjs');

    const first = await importModuleFile(file, LABEL, RECOVERY);
    const second = await importModuleFile(otherSpelling, LABEL, RECOVERY);

    assert.deepEqual([first.default(), second.default()], [1, 2]);
  });
});

describe('importCheckedDefault', () => {
  /** @param {unknown} value */
  function checkList(value) {
    if (!Array.isArray(value)) throw new UsageError('The data file d.js does not export default a list');
    return value.map((item) => item.size);
  }

  it('gives what the check returns for the default export', async () => {
    const file = await writeTestFile('checked/list.mjs', 'export default [{ size: 1 }, { size: 2 }];\n');

    assert.deepEqual(await importCheckedDefault(file, LABEL, RECOVERY, checkList), [1, 2]);
  });

  it('passes on a UsageError of the check, and names the cause of any other error the check throws', async () => {
    const notList = await writeTestFile('checked/not-list.mjs', 'export default 1;\n');
    const getterThrows = await writeTestFile('checked/getter-throws.mjs', "export default [{ get size() { throw new Error('Not measured'); } }];\n");
    const missing = join(folder, 'checked', 'missing.mjs');

    await assert.rejects(importCheckedDefault(notList, LABEL, RECOVERY, checkList), isUsageError(/^The data file d\.js does not export default a list$/));
    await assert.rejects(importCheckedDefault(getterThrows, LABEL, RECOVERY, checkList), isUsageError(/^The data file d\.js does not load\. Not measured$/));
    await assert.rejects(importCheckedDefault(missing, LABEL, RECOVERY, checkList), isUsageError(/^The data file d\.js does not exist$/));
  });
});

/**
 * @param {RegExp} pattern
 * @returns {(error: Error) => boolean}
 */
function isUsageError(pattern) {
  return (error) => error instanceof UsageError && pattern.test(error.message);
}
