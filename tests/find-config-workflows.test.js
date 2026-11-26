import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { findConfigWorkflows } from '../src/find-config-workflows.js';

const folder = await realpath(await mkdtemp(join(tmpdir(), 'dwfb-config-workflows-')));
after(() => rm(folder, { recursive: true, force: true }));

describe('findConfigWorkflows', () => {
  it('finds each workflow whose entry or out names the file of a path, through a link too, in the config order', async () => {
    await mkdir(join(folder, 'real'));
    await writeFile(join(folder, 'real', 'entry.js'), '');
    await symlink(join(folder, 'real'), join(folder, 'link'), 'junction');
    const review = { entry: join(folder, 'real', 'entry.js'), out: join(folder, 'dist', 'review.js') };
    const summary = { entry: join(folder, 'summary.js'), out: join(folder, 'dist', 'summary.js') };
    const again = { entry: join(folder, 'link', 'entry.js'), out: join(folder, 'dist', 'again.js') };
    const workflows = [review, summary, again];

    assert.deepEqual(await findConfigWorkflows(workflows, 'entry', join(folder, 'link', 'entry.js')), [review, again]);
    assert.deepEqual(await findConfigWorkflows(workflows, 'out', join(folder, 'dist', 'summary.js')), [summary]);
    assert.deepEqual(await findConfigWorkflows(workflows, 'out', join(folder, 'dist', 'missing.js')), []);
  });

  it('finds no workflow for a path that names a folder, which its real path would drop', async () => {
    const entry = join(folder, 'folder-path', 'entry.js');
    await mkdir(join(folder, 'folder-path'));
    await writeFile(entry, '');
    const workflows = [{ entry, out: join(folder, 'folder-path', 'out.js') }];

    assert.deepEqual(await findConfigWorkflows(workflows, 'entry', entry), workflows);
    assert.deepEqual(await findConfigWorkflows(workflows, 'entry', `${entry}/`), []);
    assert.deepEqual(await findConfigWorkflows(workflows, 'entry', `${entry}/.`), []);
  });
});
