import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listUnreadScenarios } from '../src/list-unread-scenarios.js';

/**
 * @param {string} name
 * @param {object} end
 * @returns {{ name: string, trace: import('../src/simulate.js').Trace }}
 */
function createRun(name, end) {
  return { name, trace: /** @type {any} */ ({ end, calls: [] }) };
}

describe('listUnreadScenarios', () => {
  it('lists each scenario that stopped or whose script was refused, in file order, with how it ended', () => {
    const runs = [
      createRun('returns', { kind: 'returned', value: null }),
      createRun('stops', { kind: 'stopped', reason: 'never-settles', message: 'the script waits on a promise that nothing settles' }),
      createRun('throws', { kind: 'threw', name: 'Error', message: 'gone', frames: [] }),
      createRun('refused', { kind: 'refused', findings: [] }),
    ];

    assert.deepEqual(listUnreadScenarios(runs), [
      { scenario: 'stops', reason: 'stopped: the script waits on a promise that nothing settles' },
      { scenario: 'refused', reason: 'refused' },
    ]);
  });

  it('lists none for runs that each reached an end of the script', () => {
    assert.deepEqual(listUnreadScenarios([createRun('returns', { kind: 'returned', value: null })]), []);
  });
});
