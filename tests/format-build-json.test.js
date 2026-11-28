import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBuildJson } from '../src/format-build-json.js';

describe('formatBuildJson', () => {
  it('names the entry by the first source, and counts the bytes of the script', () => {
    const result = { ok: true, status: 'written', script: 'é\n', sources: ['src/main.js', 'src/a.js'], findings: [] };
    assert.deepEqual(formatBuildJson([{ result, out: 'flow.js' }], true), {
      ok: true,
      workflows: [{ entry: 'src/main.js', out: 'flow.js', status: 'written', bytes: 3, sources: ['src/main.js', 'src/a.js'], findings: [] }],
    });
  });

  it('gives null bytes for a failed build, and the first difference of a stale script alone', () => {
    const failed = { ok: false, status: 'failed', script: null, sources: ['src/main.js'], findings: [] };
    const firstDifference = { line: 7, file: 'src/main.js', sourceLine: 2 };
    const stale = { ok: false, status: 'stale', script: 'x\n', sources: ['src/main.js'], findings: [], firstDifference };
    const [failedJson, staleJson] = formatBuildJson([{ result: failed, out: 'a.js' }, { result: stale, out: 'b.js' }], false).workflows;
    assert.equal(failedJson.bytes, null);
    assert.equal(Object.hasOwn(failedJson, 'firstDifference'), false);
    assert.deepEqual(staleJson.firstDifference, firstDifference);
  });
});
