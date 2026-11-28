import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatValidateJson } from '../src/format-validate-json.js';

describe('formatValidateJson', () => {
  it('gives ok, the runtime version, the script and findings of each result, and the skipped outs', () => {
    const results = [{ ok: true, script: 'good.js', runtime: '2.1.332', findings: [] }];
    assert.deepEqual(formatValidateJson(results, ['skip.js'], true), {
      ok: true,
      runtime: CONTRACT_RUNTIME_VERSION,
      scripts: [{ script: 'good.js', findings: [] }],
      skipped: ['skip.js'],
    });
  });
});
