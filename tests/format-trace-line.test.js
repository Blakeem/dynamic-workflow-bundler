import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatTraceLine } from '../src/format-trace-line.js';

const CALL = { index: 0, label: 'review', prompt: 'p', opts: { label: 'review' }, group: null, phase: null, returned: 'ok' };

/**
 * @param {import('../src/simulate.js').TraceEnd} end
 * @param {import('../src/simulate.js').TraceCall[]} calls
 * @returns {import('../src/simulate.js').Trace}
 */
function createTrace(end, calls) {
  return { script: 'flow.js', scenario: 'passes', runtime: '2.1.332', end, calls, groups: [], phases: [], logs: [], events: [] };
}

describe('formatTraceLine', () => {
  it('names the script, the scenario, how the simulation ended and the count of calls', () => {
    const simulation = { script: 'flow.js', scenario: 'passes', expect: 'returned', passed: true, trace: createTrace({ kind: 'returned', value: 1 }, [CALL]) };
    assert.equal(formatTraceLine(simulation), 'flow.js passes: returned, 1 call.');
  });

  it('writes each character of the scenario name a terminal does not show as its escape', () => {
    const simulation = { script: 'flow.js', scenario: 'two\tlines', expect: 'returned', passed: false, trace: createTrace({ kind: 'returned', value: 1 }, []) };
    assert.equal(formatTraceLine(simulation), 'flow.js two\\u{0009}lines: returned, 0 calls.');
  });
});
