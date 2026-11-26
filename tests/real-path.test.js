import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { findRealPath } from '../src/real-path.js';

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
