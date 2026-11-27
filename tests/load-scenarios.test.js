import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadScenarios } from '../src/load-scenarios.js';

const folder = await mkdtemp(join(tmpdir(), 'dwfb-scenarios-'));
await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

/**
 * @param {string} name
 * @param {string} text
 * @returns {Promise<string>} The file's absolute path.
 */
async function writeScenariosFile(name, text) {
  const file = join(folder, name);
  await writeFile(file, text);
  return file;
}

/**
 * @param {string} path
 * @param {string} message
 */
async function assertUsageError(path, message) {
  await assert.rejects(loadScenarios(path), (error) => error.name === 'UsageError' && error.message === message);
}

describe('loadScenarios', () => {
  it('loads the checked scenarios of the default export', async () => {
    const file = await writeScenariosFile('list.js', "export default [{ name: 'a', respond: { review: 'pass' } }, { name: 'b', expect: 'threw' }];\n");

    assert.deepEqual(await loadScenarios(file), [
      { name: 'a', expect: 'returned', scenario: { name: 'a', respond: { review: 'pass' } } },
      { name: 'b', expect: 'threw', scenario: { name: 'b' } },
    ]);
  });

  it('names a missing file, a folder and a file with no default export by the path as given', async () => {
    const noDefault = await writeScenariosFile('no-default.js', 'export const scenarios = [];\n');
    await mkdir(join(folder, 'sub'));

    await assertUsageError(join(folder, 'missing.js'), `The scenarios file ${join(folder, 'missing.js')} does not exist`);
    await assertUsageError(join(folder, 'sub'), `The scenarios file ${join(folder, 'sub')} is not a file`);
    await assertUsageError(noDefault, `The scenarios file ${noDefault} does not export default a list of scenarios of the form { name, args, respond, budget, expect }`);
  });

  it('names the cause when the file throws as it loads or as its default export is read', async () => {
    const throwsOnLoad = await writeScenariosFile('throws.js', "throw new Error('Not ready');\n");
    const throwsOnRead = await writeScenariosFile('getter.js', "export default [{ get name() { throw new Error('No name yet'); } }];\n");

    await assertUsageError(throwsOnLoad, `The scenarios file ${throwsOnLoad} does not load. Not ready`);
    await assertUsageError(throwsOnRead, `The scenarios file ${throwsOnRead} does not load. No name yet`);
  });
});
