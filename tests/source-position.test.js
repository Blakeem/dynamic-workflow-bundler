import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countLineBreaks, findPosition } from '../src/source-position.js';

describe('findPosition', () => {
  it('gives the 1-based line and column of an offset', () => {
    assert.deepEqual(findPosition('ab\ncd', 0), { line: 1, column: 1 });
    assert.deepEqual(findPosition('ab\ncd', 4), { line: 2, column: 2 });
    assert.deepEqual(findPosition('ab\n', 3), { line: 2, column: 1 });
  });

  it('counts only LF as a line break', () => {
    assert.deepEqual(findPosition('a b', 2), { line: 1, column: 3 });
  });
});

describe('countLineBreaks', () => {
  it('counts only LF as a line break, as findPosition does', () => {
    assert.equal(countLineBreaks(''), 0);
    assert.equal(countLineBreaks('a\nb\n'), 2);
    assert.equal(countLineBreaks('a b c\r'), 0);
  });
});
