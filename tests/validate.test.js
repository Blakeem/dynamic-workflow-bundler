import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { validate } from 'dynamic-workflow-bundler';
import { SCRIPT_BYTE_LIMIT } from '../src/check-contract.js';
import { formatRealDisplayPath } from '../src/real-path.js';
import { VALIDATE_READ_BYTE_LIMIT } from '../src/validate.js';

const META = "export const meta = { name: 'p', description: 'd' };\n";
const INVALID_BYTE = 0xff;

const temporaryFolders = [];
after(async () => {
  for (const folder of temporaryFolders) await rm(folder, { recursive: true, force: true });
});

/**
 * @param {string | Buffer} content
 * @returns {Promise<{ folder: string, script: string }>} A new folder, and the script written in it.
 */
async function writeTemporaryScript(content) {
  const folder = await mkdtemp(join(tmpdir(), 'dwfb-validate-'));
  const script = join(folder, 'workflow.js');
  temporaryFolders.push(folder);
  await writeFile(script, content);
  return { folder, script };
}

/**
 * @param {number} byteCount
 * @returns {Buffer} A script of this many bytes that breaks no rule, whose comment holds bytes that are not
 *   valid UTF-8, so that its text as the runtime decodes it is larger than the file.
 */
function createInvalidByteScript(byteCount) {
  const head = Buffer.from(`${META}//`);
  const invalidBytes = Buffer.alloc(byteCount - head.length - 1, INVALID_BYTE);
  return Buffer.concat([head, invalidBytes, Buffer.from('\n')]);
}

/**
 * @param {number} byteCount
 * @returns {string} A script of this many bytes of ASCII that calls Date.now().
 */
function createClockScript(byteCount) {
  const head = `${META}return Date.now();\n//`;
  return `${head}${'a'.repeat(byteCount - head.length - 1)}\n`;
}

describe('validate', () => {
  it('resolves ok with no finding for a script that breaks no rule', async () => {
    const { script } = await writeTemporaryScript(`${META}return 1;\n`);

    assert.deepEqual(await validate({ script }), { ok: true, script: await formatRealDisplayPath(script), runtime: '2.1.332', findings: [] });
  });

  it('resolves each finding, sorted, with the script path as formatRealDisplayPath gives it', async () => {
    const { script } = await writeTemporaryScript(`${META}const started = Date.now();\nreturn require(started);\n`);
    const scriptPath = await formatRealDisplayPath(script);

    const result = await validate({ script });

    assert.equal(result.ok, false);
    assert.equal(result.script, scriptPath);
    assert.deepEqual(result.findings.map((finding) => `${finding.file} ${finding.line}:${finding.column} ${finding.rule}`), [
      `${scriptPath} 2:17 clock-unavailable`,
      `${scriptPath} 3:8 global-undefined`,
    ]);
  });

  it('reads a byte that is not valid UTF-8 as U+FFFD, and reports no encoding finding', async () => {
    const { script: inString } = await writeTemporaryScript(Buffer.concat([Buffer.from(`${META}return '`), Buffer.from([INVALID_BYTE]), Buffer.from("';\n")]));
    // U+FFFD cannot sit in a name, where the latin1 reading of 0xFF, ÿ, can.
    const { script: inName } = await writeTemporaryScript(Buffer.concat([Buffer.from(`${META}const a`), Buffer.from([INVALID_BYTE]), Buffer.from(' = 1;\n')]));

    assert.deepEqual((await validate({ script: inString })).findings, []);
    assert.deepEqual((await validate({ script: inName })).findings.map((finding) => `${finding.rule} ${finding.line}:${finding.column} ${finding.message}`), [
      "syntax-error 2:8 Unexpected character '\u{FFFD}'",
    ]);
  });

  it('reads a script with a byte order mark, as the runtime runs it', async () => {
    const { script } = await writeTemporaryScript(`﻿${META}return 1;\n`);

    assert.deepEqual((await validate({ script })).findings, []);
  });

  it('measures script-too-large on the size of the file, not of the decoded text', async () => {
    const limitScript = createInvalidByteScript(SCRIPT_BYTE_LIMIT);
    const { script: limitFile } = await writeTemporaryScript(limitScript);
    const { script: largeFile } = await writeTemporaryScript(createInvalidByteScript(SCRIPT_BYTE_LIMIT + 1));

    assert.ok(Buffer.byteLength(limitScript.toString('utf8')) > SCRIPT_BYTE_LIMIT);
    assert.deepEqual((await validate({ script: limitFile })).findings, []);
    assert.deepEqual((await validate({ script: largeFile })).findings.map((finding) => `${finding.rule} ${finding.line}:${finding.column} ${finding.message}`), [
      'script-too-large 1:1 The script is 524289 bytes, which is more than the 524288 bytes the runtime reads',
    ]);
  });

  it('checks every rule up to VALIDATE_READ_BYTE_LIMIT bytes, and reports script-too-large alone for a larger file', async () => {
    const { script: limitFile } = await writeTemporaryScript(createClockScript(VALIDATE_READ_BYTE_LIMIT));
    const { script: largeFile } = await writeTemporaryScript(createClockScript(VALIDATE_READ_BYTE_LIMIT + 1));
    const largePath = await formatRealDisplayPath(largeFile);

    assert.deepEqual((await validate({ script: limitFile })).findings.map((finding) => finding.rule), ['script-too-large', 'clock-unavailable']);
    assert.deepEqual(await validate({ script: largeFile }), {
      ok: false,
      script: largePath,
      runtime: '2.1.332',
      findings: [{
        rule: 'script-too-large',
        message: `The script is ${VALIDATE_READ_BYTE_LIMIT + 1} bytes, which is more than the 524288 bytes the runtime reads`,
        fix: 'Pass long text through args, or move part of the work into a workflow that the script runs with workflow()',
        file: largePath,
        line: 1,
        column: 1,
      }],
    });
  });

  it('rejects a missing script, a folder, a path that ends in a separator or a . or .. segment, and options of another shape', async () => {
    const { folder, script } = await writeTemporaryScript(`${META}return 1;\n`);
    await mkdir(join(folder, 'sub'));
    const missing = join(folder, 'missing.js');
    const rejections = [
      [{ script: missing }, `The script file ${missing} does not exist`],
      [{ script: folder }, /^The script .* is not a file$/],
      [{ script: `${folder}/` }, /^The script .* is not a file$/],
      [{ script: `${folder}/sub/.` }, /^The script .* is not a file$/],
      [{ script: `${folder}/sub/..` }, /^The script .* is not a file$/],
      [{ script: '' }, /^validate\(\) needs script, the path of a workflow script$/],
      [{ script: 5 }, /^validate\(\) needs script/],
      [{}, /^validate\(\) needs script/],
      [{ script, Script: script }, /^validate\(\) takes no option Script$/],
      [null, /^validate\(\) takes an options object$/],
      [[script], /^validate\(\) takes an options object$/],
      [script, /^validate\(\) takes an options object$/],
    ];

    for (const [options, message] of rejections) await assert.rejects(validate(options), { name: 'UsageError', message }, JSON.stringify(options));
  });
});
