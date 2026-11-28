import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeDigits } from '../src/normalize-digits.js';

describe('normalizeDigits', () => {
  it('writes each run of ASCII digits as N, and keeps every other character', () => {
    assert.equal(normalizeDigits('round 3 of 5'), 'round N of N');
    assert.equal(normalizeDigits('round 12 of 40'), 'round N of N');
    assert.equal(normalizeDigits('v1.20-r3x'), 'vN.N-rNx');
    assert.equal(normalizeDigits('done'), 'done');
    assert.equal(normalizeDigits('round ٣'), 'round ٣');
  });
});
