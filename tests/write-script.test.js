import assert from 'node:assert/strict';
import fsPromises, { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { writeScript } from '../src/write-script.js';

const temporaryFolders = [];
after(async () => {
  for (const folder of temporaryFolders) await rm(folder, { recursive: true, force: true });
});

/** @returns {Promise<string>} */
async function makeTemporaryFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'dwfb-write-'));
  temporaryFolders.push(folder);
  return folder;
}

describe('writeScript', () => {
  it('replaces an earlier script and creates a missing folder', async () => {
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'dist'));
    await writeFile(join(folder, 'dist', 'out.js'), 'earlier');

    await writeScript(join(folder, 'dist', 'out.js'), 'later');
    await writeScript(join(folder, 'new', 'out.js'), 'new');

    assert.equal(await readFile(join(folder, 'dist', 'out.js'), 'utf8'), 'later');
    assert.equal(await readFile(join(folder, 'new', 'out.js'), 'utf8'), 'new');
    assert.deepEqual(await readdir(join(folder, 'dist')), ['out.js']);
  });

  it('writes an out file whose name is as long as a file name may be', async () => {
    const folder = await makeTemporaryFolder();
    const outName = `${'a'.repeat(252)}.js`;

    await writeScript(join(folder, outName), 'script');

    assert.deepEqual(await readdir(folder), [outName]);
  });

  it('removes the temporary file and names the out file when the rename fails', async () => {
    const folder = await makeTemporaryFolder();
    const outFile = join(folder, 'out.js');
    await mkdir(outFile);
    await writeFile(join(outFile, 'kept.txt'), 'kept');

    await assert.rejects(writeScript(outFile, 'script'), (error) => {
      assert.deepEqual({ path: error.path, syscall: error.syscall, code: typeof error.code }, { path: outFile, syscall: 'rename', code: 'string' });
      return true;
    });

    assert.deepEqual(await readdir(folder), ['out.js']);
    assert.deepEqual(await readdir(outFile), ['kept.txt']);
  });

  it('keeps the rename error when the temporary file cannot be removed', async (context) => {
    const folder = await makeTemporaryFolder();
    const outFile = join(folder, 'out.js');
    await mkdir(outFile);
    await writeFile(join(outFile, 'kept.txt'), 'kept');
    const busyError = Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'rm', path: join(folder, 'held.tmp') });
    // The named import in write-script.js reads the builtin's export object only after a sync.
    const failingRm = context.mock.method(fsPromises, 'rm', async () => { throw busyError; });
    syncBuiltinESMExports();

    try {
      await assert.rejects(writeScript(outFile, 'script'), (error) => {
        assert.deepEqual({ path: error.path, syscall: error.syscall }, { path: outFile, syscall: 'rename' });
        return true;
      });
      assert.equal(failingRm.mock.callCount(), 1);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it('names the out file when its folder cannot be created', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'file'), 'kept');
    const outFile = join(folder, 'file', 'dist', 'out.js');

    await assert.rejects(writeScript(outFile, 'script'), (error) => {
      assert.deepEqual({ path: error.path, syscall: error.syscall, code: typeof error.code }, { path: outFile, syscall: 'mkdir', code: 'string' });
      return true;
    });

    assert.deepEqual(await readdir(folder), ['file']);
  });

  it('names the out file when the temporary file cannot be written', async (context) => {
    if (process.platform === 'win32') return context.skip('Windows ignores the write permission of a folder');
    if (process.getuid?.() === 0) return context.skip('root writes in every folder');
    const folder = await makeTemporaryFolder();
    const outFile = join(folder, 'out.js');
    await chmod(folder, 0o555);

    try {
      await assert.rejects(writeScript(outFile, 'script'), (error) => {
        assert.deepEqual({ path: error.path, syscall: error.syscall, code: error.code }, { path: outFile, syscall: 'open', code: 'EACCES' });
        return true;
      });
    } finally {
      await chmod(folder, 0o755);
    }
    assert.deepEqual(await readdir(folder), []);
  });
});
