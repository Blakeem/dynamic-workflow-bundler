import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isUnfinishedTrace } from '../src/is-unfinished-trace.js';

/**
 * @param {object} end
 * @returns {boolean}
 */
function isUnfinishedEnd(end) {
  return isUnfinishedTrace(/** @type {any} */ ({ end, calls: [] }));
}

describe('isUnfinishedTrace', () => {
  it('is true for a simulation that stopped and for a script that was refused', () => {
    assert.equal(isUnfinishedEnd({ kind: 'stopped', reason: 'unanswered', message: 'no scripted return answers it', call: 0 }), true);
    assert.equal(isUnfinishedEnd({ kind: 'refused', findings: [] }), true);
  });

  it('is false for a script that returned or threw', () => {
    assert.equal(isUnfinishedEnd({ kind: 'returned', value: null }), false);
    assert.equal(isUnfinishedEnd({ kind: 'threw', name: 'Error', message: 'gone', frames: [] }), false);
  });
});
