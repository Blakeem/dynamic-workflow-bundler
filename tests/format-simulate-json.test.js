import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatSimulateJson } from '../src/format-simulate-json.js';

describe('formatSimulateJson', () => {
  it('gives ok, the runtime version and each simulation with its trace', () => {
    const trace = { script: 'flow.js', scenario: 'passes', runtime: '2.1.332', end: { kind: 'returned', value: 1 }, calls: [], groups: [], phases: [], logs: [], events: [] };
    const simulation = { script: 'flow.js', scenario: 'passes', expect: 'returned', passed: true, trace };
    assert.deepEqual(formatSimulateJson([simulation], true), { ok: true, runtime: CONTRACT_RUNTIME_VERSION, simulations: [simulation] });
  });
});
