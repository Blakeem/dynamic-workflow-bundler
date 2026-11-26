import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readScript } from '../src/read-script.js';

const folder = await mkdtemp(join(tmpdir(), 'dwfb-read-script-'));
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('readScript', () => {
  it('gives the bytes of a file of byteLimit bytes, a byte that is not valid UTF-8 and a byte order mark included', async () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x31, 0xff, 0x0a]);
    const script = join(folder, 'bytes.js');
    await writeFile(script, bytes);

    assert.deepEqual(await readScript(script, bytes.length), { size: bytes.length, bytes });
  });

  it('gives the size and no bytes for a file larger than byteLimit', async () => {
    const script = join(folder, 'large.js');
    await writeFile(script, 'return 1;\n');

    assert.deepEqual(await readScript(script, 9), { size: 10, bytes: null });
  });

  it('rejects a missing script, a folder and a path that ends in a separator', async () => {
    const missing = join(folder, 'missing.js');

    await assert.rejects(readScript(missing, 1), { name: 'UsageError', message: `The script file ${missing} does not exist` });
    await assert.rejects(readScript(folder, 1), { name: 'UsageError', message: `The script ${folder} is not a file` });
    await assert.rejects(readScript(`${folder}/`, 1), { name: 'UsageError', message: `The script ${folder}/ is not a file` });
  });
});
