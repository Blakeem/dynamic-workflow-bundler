import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countLineBreaks, countLines, findPosition, readPositionText, replaceLoneCarriageReturns } from '../src/source-position.js';

describe('findPosition', () => {
  it('gives the 1-based line and column of an offset', () => {
    assert.deepEqual(findPosition('ab\ncd', 0), { line: 1, column: 1 });
    assert.deepEqual(findPosition('ab\ncd', 4), { line: 2, column: 2 });
    assert.deepEqual(findPosition('ab\n', 3), { line: 2, column: 1 });
  });

  it('counts only LF as a line break', () => {
    assert.deepEqual(findPosition('a\u2028b', 2), { line: 1, column: 3 });
  });
});

describe('replaceLoneCarriageReturns', () => {
  it('replaces each lone CR with LF, keeps CRLF and keeps the length', () => {
    const text = 'a\rb\r\nc\r\rd\r';
    const replaced = replaceLoneCarriageReturns(text);

    assert.equal(replaced, 'a\nb\r\nc\n\nd\n');
    assert.equal(replaced.length, text.length);
    assert.deepEqual(findPosition(replaced, text.indexOf('d')), { line: 5, column: 1 });
  });
});

describe('readPositionText', () => {
  it('drops a leading byte order mark and gives its length, and replaces each lone CR with LF', () => {
    assert.deepEqual(readPositionText('\uFEFFa\nb'), { positionText: 'a\nb', markLength: 1 });
    assert.deepEqual(readPositionText('a\rb\r\nc'), { positionText: 'a\nb\r\nc', markLength: 0 });
    assert.deepEqual(readPositionText('a\uFEFFb'), { positionText: 'a\uFEFFb', markLength: 0 });
  });
});

describe('countLines', () => {
  it('counts no line after the last line break, and counts only LF as a line break', () => {
    assert.equal(countLines(''), 1);
    assert.equal(countLines('a\nb'), 2);
    assert.equal(countLines('a\nb\n'), 2);
    assert.equal(countLines('a\u2028b'), 1);
  });
});

describe('countLineBreaks', () => {
  it('counts only LF as a line break, as findPosition does', () => {
    assert.equal(countLineBreaks(''), 0);
    assert.equal(countLineBreaks('a\nb\n'), 2);
    assert.equal(countLineBreaks('a\u2028b\u2029c\r'), 0);
  });
});
