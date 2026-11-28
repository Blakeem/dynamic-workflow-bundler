import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatSnapshotJson } from '../src/format-snapshot-json.js';

/**
 * @param {Partial<import('../src/snapshot.js').SnapshotResult>} fields
 * @returns {import('../src/snapshot.js').SnapshotResult}
 */
function createResult(fields) {
  return { ok: true, script: 'flow.js', runtime: '2.1.332', variants: [], roles: [], callCount: 1, digest: 'd', promptBudgetProblems: [], unread: [], ...fields };
}

describe('formatSnapshotJson', () => {
  it('gives each snapshot its script, file, check and findings around the fields of its SnapshotResult', () => {
    const result = createResult({ ok: false, variants: null, callCount: 0, digest: null, unread: [{ scenario: 'passes', reason: 'refused' }] });
    const findings = [{ rule: 'meta-not-first', message: 'The script does not open with meta', fix: 'Move meta first', file: 'flow.js', line: 1, column: 1 }];

    assert.deepEqual(formatSnapshotJson([{ result, fileLabel: 'docs/flow.prompts.md', findings }], [null], false), {
      ok: false,
      runtime: CONTRACT_RUNTIME_VERSION,
      snapshots: [{ script: 'flow.js', file: 'docs/flow.prompts.md', check: null, ...result, findings }],
    });
  });

  it('keeps the keys in the order script, file, check, then the SnapshotResult and findings', () => {
    const [snapshotJson] = formatSnapshotJson([{ result: createResult({}), fileLabel: null, findings: [] }], ['fresh'], true).snapshots;

    assert.deepEqual(Object.keys(snapshotJson), ['script', 'file', 'check', 'ok', 'runtime', 'variants', 'roles', 'callCount', 'digest', 'promptBudgetProblems', 'unread', 'findings']);
    assert.equal(snapshotJson.check, 'fresh');
  });
});
