import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatSimulateText } from '../src/format-simulate-text.js';

const FINDING = { rule: 'meta-not-first', message: 'The script does not open with meta', fix: 'Move meta first', file: 'flow.js', line: 1, column: 1 };

/**
 * @param {string} scenario
 * @param {import('../src/simulate.js').TraceEnd} end
 * @param {boolean} passed
 * @returns {import('../src/format-trace-line.js').Simulation}
 */
function createSimulation(scenario, end, passed) {
  const trace = { script: 'flow.js', scenario, runtime: '2.1.332', end, calls: [], groups: [], phases: [], logs: [], events: [] };
  return { script: 'flow.js', scenario, expect: 'returned', passed, trace };
}

describe('formatSimulateText', () => {
  it('marks each failed simulation and ends with the counts of passed and failed scenarios', () => {
    const simulations = [createSimulation('passes', { kind: 'returned', value: 1 }, true), createSimulation('throws', { kind: 'threw', name: 'Error', message: 'boom', frames: [] }, false)];
    assert.equal(formatSimulateText(simulations), 'flow.js passes: returned, 0 calls.\nFAILED flow.js throws: threw Error: boom, 0 calls.\n1 passed, 1 failed.\n');
  });

  it('prints the findings of a refused script once, before its first simulation', () => {
    const refused = { kind: 'refused', findings: [FINDING] };
    const simulations = [createSimulation('first', refused, false), createSimulation('second', refused, false)];
    assert.equal(formatSimulateText(simulations), [
      'flow.js:1:1 meta-not-first The script does not open with meta. Move meta first.',
      'FAILED flow.js first: refused, 0 calls.',
      'FAILED flow.js second: refused, 0 calls.',
      '0 passed, 2 failed.',
      '',
    ].join('\n'));
  });
});
