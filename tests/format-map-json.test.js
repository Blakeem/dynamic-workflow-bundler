import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatMapJson } from '../src/format-map-json.js';

describe('formatMapJson', () => {
  it('gives each map its script, file, check and findings around the fields of its MapResult', () => {
    const result = { ok: false, script: 'flow.js', runtime: '2.1.332', graph: null, unmapped: [{ scenario: 'passes', reason: 'refused' }] };
    const findings = [{ rule: 'meta-not-first', message: 'The script does not open with meta', fix: 'Move meta first', file: 'flow.js', line: 1, column: 1 }];
    assert.deepEqual(formatMapJson([{ result, fileLabel: 'docs/flow.md', findings }], ['stale'], false), {
      ok: false,
      runtime: CONTRACT_RUNTIME_VERSION,
      maps: [{ script: 'flow.js', file: 'docs/flow.md', check: 'stale', ...result, findings }],
    });
  });

  it('keeps the keys in the order script, file, check, then the MapResult and findings', () => {
    const result = { ok: true, script: 'flow.js', runtime: '2.1.332', graph: null, unmapped: [] };
    const [mapJson] = formatMapJson([{ result, fileLabel: null, findings: [] }], [null], true).maps;
    assert.deepEqual(Object.keys(mapJson), ['script', 'file', 'check', 'ok', 'runtime', 'graph', 'unmapped', 'findings']);
  });
});
