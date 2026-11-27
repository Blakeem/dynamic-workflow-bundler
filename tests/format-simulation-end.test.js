import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatSimulationEnd } from '../src/format-simulation-end.js';

const CALL = { index: 0, label: 'review', prompt: 'p', opts: { label: 'review' }, group: null, phase: null };

/**
 * @param {import('../src/simulate.js').TraceEnd} end
 * @param {import('../src/simulate.js').TraceCall[]} [calls]
 * @returns {string}
 */
function formatEnd(end, calls = []) {
  return formatSimulationEnd({ script: 'flow.js', scenario: null, runtime: '2.1.332', end, calls, groups: [], phases: [], logs: [], events: [] });
}

describe('formatSimulationEnd', () => {
  it('names a return and a refusal by their kind', () => {
    assert.equal(formatEnd({ kind: 'returned', value: 1 }), 'returned');
    assert.equal(formatEnd({ kind: 'refused', findings: [] }), 'refused');
  });

  it('names the error a script threw, with each character a terminal does not show as its escape', () => {
    assert.equal(formatEnd({ kind: 'threw', name: 'TypeError', message: 'boom\tnow' }), 'threw TypeError: boom\\u{0009}now');
  });

  it('names the call a simulation stopped at, and no call for a stop at none', () => {
    assert.equal(formatEnd({ kind: 'stopped', reason: 'unanswered', message: 'No key', call: 0 }, [CALL]), 'stopped at call 0 (label "review"): No key');
    assert.equal(formatEnd({ kind: 'stopped', reason: 'never-settles', message: 'Waits' }), 'stopped: Waits');
  });
});
