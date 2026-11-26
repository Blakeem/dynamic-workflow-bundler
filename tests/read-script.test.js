import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { READ_BYTE_LIMIT } from '../src/read-byte-limit.js';
import { readScript } from '../src/read-script.js';
import { writeSizedFile } from './support/write-sized-file.js';

const folder = await mkdtemp(join(tmpdir(), 'dwfb-read-script-'));
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('readScript', () => {
  it('gives the bytes of a file, a byte that is not valid UTF-8 and a byte order mark included', async () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x31, 0xff, 0x0a]);
    const script = join(folder, 'bytes.js');
    await writeFile(script, bytes);

    assert.deepEqual(await readScript(script), { size: bytes.length, bytes });
  });

  it('gives the bytes of a file of READ_BYTE_LIMIT bytes, and the size and no bytes for a larger file', async () => {
    const limitScript = join(folder, 'limit.js');
    const largeScript = join(folder, 'large.js');
    await writeSizedFile(limitScript, READ_BYTE_LIMIT);
    await writeSizedFile(largeScript, READ_BYTE_LIMIT + 1);

    assert.equal((await readScript(limitScript)).bytes?.length, READ_BYTE_LIMIT);
    assert.deepEqual(await readScript(largeScript), { size: READ_BYTE_LIMIT + 1, bytes: null });
  });

  it('rejects a missing script, a folder and a path that ends in a separator', async () => {
    const missing = join(folder, 'missing.js');

    await assert.rejects(readScript(missing), { name: 'UsageError', message: `The script file ${missing} does not exist` });
    await assert.rejects(readScript(folder), { name: 'UsageError', message: `The script ${folder} is not a file` });
    await assert.rejects(readScript(`${folder}/`), { name: 'UsageError', message: `The script ${folder}/ is not a file` });
  });
});
