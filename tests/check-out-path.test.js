import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkOutPath } from '../src/check-out-path.js';

const folder = await mkdtemp(join(tmpdir(), 'dwfb-check-out-path-'));
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('checkOutPath', () => {
  it('accepts an existing file and a missing file whose nearest existing folder above it is a folder', async () => {
    await writeFile(join(folder, 'old.md'), 'old\n');

    await checkOutPath(join(folder, 'old.md'), 'The path old.md');
    await checkOutPath(join(folder, 'new', 'deeper', 'new.md'), 'The path new/deeper/new.md');
  });

  it('rejects a path that names a folder, and a path inside a file at any depth', async () => {
    await mkdir(join(folder, 'maps'));
    await writeFile(join(folder, 'notes.txt'), 'notes\n');

    await assert.rejects(checkOutPath(join(folder, 'maps'), 'The path maps'), { name: 'UsageError', message: 'The path maps is not a file' });
    await assert.rejects(checkOutPath(join(folder, 'notes.txt', 'a.md'), 'The path notes.txt/a.md'), { name: 'UsageError', message: 'The path notes.txt/a.md is inside a file' });
    await assert.rejects(checkOutPath(join(folder, 'notes.txt', 'deeper', 'a.md'), 'The path notes.txt/deeper/a.md'), { name: 'UsageError', message: 'The path notes.txt/deeper/a.md is inside a file' });
  });
});
