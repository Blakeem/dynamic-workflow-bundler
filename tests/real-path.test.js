import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findRealPath, formatRealDisplayPath } from '../src/real-path.js';

const folder = await realpath(await mkdtemp(join(tmpdir(), 'dwfb-real-path-')));
after(() => rm(folder, { recursive: true, force: true }));

describe('findRealPath', () => {
  it('gives the real path of a file reached through a link', async () => {
    await mkdir(join(folder, 'real'));
    await writeFile(join(folder, 'real', 'a.js'), '');
    await symlink(join(folder, 'real'), join(folder, 'link'), 'junction');

    assert.equal(await findRealPath(join(folder, 'link', 'a.js')), join(folder, 'real', 'a.js'));
  });

  it('joins the real path of the nearest existing folder with the rest of a path that does not exist yet', async () => {
    await mkdir(join(folder, 'dist'));
    await symlink(join(folder, 'dist'), join(folder, 'linked'), 'junction');

    assert.equal(await findRealPath(join(folder, 'linked', 'new', 'out.js')), join(folder, 'dist', 'new', 'out.js'));
    assert.equal(await findRealPath(join(folder, 'dist')), join(folder, 'dist'));
  });
});

describe('formatRealDisplayPath', () => {
  it('names a path relative to the real path of the working directory, and keeps the spelling of its last name', async () => {
    const workFolder = process.cwd();
    await mkdir(join(folder, 'source'));
    await symlink(join(folder, 'source'), join(folder, 'source-link'), 'junction');

    process.chdir(join(folder, 'source-link'));
    try {
      assert.equal(await formatRealDisplayPath(join(folder, 'source', 'a.js')), 'a.js');
      assert.equal(await formatRealDisplayPath(join('new', 'out.js')), 'new/out.js');
      assert.equal(await formatRealDisplayPath(join(folder, 'source')), '.');
      assert.equal(await formatRealDisplayPath(join(folder, 'source-link')), '../source-link');
      // On POSIX the working directory's name is its real path, so only a link below it tells the two bases apart.
      process.chdir(folder);
      assert.equal(await formatRealDisplayPath(join('source-link', 'new', 'out.js')), 'source/new/out.js');
    } finally {
      process.chdir(workFolder);
    }
  });

  it('names a path whose real folder is on another drive as the working directory reaches it', async (context) => {
    const workFolder = process.cwd();
    const otherDriveFolder = fileURLToPath(new URL('./fixtures/', import.meta.url));
    if (parse(otherDriveFolder).root.toLowerCase() === parse(folder).root.toLowerCase()) {
      return context.skip('the fixtures sit on the drive of the temporary folder');
    }
    await symlink(otherDriveFolder, join(folder, 'other-drive'), 'junction');

    process.chdir(folder);
    try {
      assert.equal(await formatRealDisplayPath(join('other-drive', 'out.js')), 'other-drive/out.js');
    } finally {
      process.chdir(workFolder);
    }
  });
});
