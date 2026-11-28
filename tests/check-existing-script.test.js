import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BANNER_END, BANNER_START } from '../src/banner.js';
import { checkExistingScript } from '../src/check-existing-script.js';
import { READ_BYTE_LIMIT } from '../src/read-byte-limit.js';

const BANNER_SCRIPT = `export const meta = { name: 'p', description: 'd' };\n${BANNER_START}entry.js${BANNER_END}\nreturn 1;\n`;
const NO_BANNER_SCRIPT = "export const meta = { name: 'p', description: 'd' };\nreturn 1;\n";

const folder = await mkdtemp(join(tmpdir(), 'dwfb-check-existing-script-'));
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('checkExistingScript', () => {
  it('accepts a missing file, a built script with a banner, and with no banner a script whose first statement is the meta statement', async () => {
    await writeFile(join(folder, 'banner.js'), BANNER_SCRIPT);
    await writeFile(join(folder, 'no-banner.js'), NO_BANNER_SCRIPT);

    await checkExistingScript(join(folder, 'missing.js'), 'missing.js', true);
    await checkExistingScript(join(folder, 'banner.js'), 'banner.js', true);
    await checkExistingScript(join(folder, 'no-banner.js'), 'no-banner.js', false);
  });

  it('rejects a hand-written file, a script with no banner for a build with a banner, and an empty file, and keeps their bytes', async () => {
    const cases = [
      ['notes.md', '# Notes\n', true],
      ['no-banner.js', NO_BANNER_SCRIPT, true],
      ['empty.js', '', false],
    ];

    for (const [name, text, banner] of cases) {
      await writeFile(join(folder, name), text);
      await assert.rejects(checkExistingScript(join(folder, name), `dist/${name}`, banner), {
        name: 'UsageError',
        message: `The out file dist/${name} exists and is no script that dwfb build wrote ${banner ? 'with a banner' : 'with no banner'}, so remove the file or name another one`,
      });
      assert.equal(await readFile(join(folder, name), 'utf8'), text);
    }
  });

  it('rejects a file larger than READ_BYTE_LIMIT that starts as a built script', async () => {
    await writeFile(join(folder, 'large.js'), `${BANNER_SCRIPT}${' '.repeat(READ_BYTE_LIMIT)}`);

    await assert.rejects(checkExistingScript(join(folder, 'large.js'), 'large.js', true), { name: 'UsageError', message: /^The out file large\.js exists and is no script/ });
  });
});
