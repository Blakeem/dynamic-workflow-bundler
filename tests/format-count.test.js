import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCount } from '../src/format-count.js';

describe('formatCount', () => {
  it('gives the singular for 1 and the plural for every other count', () => {
    assert.equal(formatCount(1, 'call'), '1 call');
    assert.equal(formatCount(0, 'call'), '0 calls');
    assert.equal(formatCount(2, 'character'), '2 characters');
  });
});
