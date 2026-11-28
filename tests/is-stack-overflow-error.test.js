import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isStackOverflowError } from '../src/is-stack-overflow-error.js';

describe('isStackOverflowError', () => {
  it('is true for the error of a recursion that overflows the stack, and false for another RangeError', () => {
    const recurse = () => recurse();
    let overflowError = null;
    try {
      recurse();
    } catch (error) {
      overflowError = error;
    }

    assert.equal(isStackOverflowError(overflowError), true);
    assert.equal(isStackOverflowError(new RangeError('Invalid array length')), false);
    assert.equal(isStackOverflowError(new Error('Maximum call stack size exceeded')), false);
  });
});
