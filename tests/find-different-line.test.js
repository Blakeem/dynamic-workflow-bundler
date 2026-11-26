import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findDifferentLine } from '../src/find-different-line.js';

const BUILT = Buffer.from('one\ntwo\nthree\n');

describe('findDifferentLine', () => {
  it('gives null for equal bytes', () => {
    assert.equal(findDifferentLine(BUILT, Buffer.from('one\ntwo\nthree\n')), null);
  });

  it('gives the line of the first differing byte', () => {
    assert.equal(findDifferentLine(BUILT, Buffer.from('one\ntwo\nthrée\n')), 3);
    assert.equal(findDifferentLine(BUILT, Buffer.from('One\ntwo\nthree\n')), 1);
  });

  it('finds a line ending that differs', () => {
    assert.equal(findDifferentLine(BUILT, Buffer.from('one\r\ntwo\r\nthree\r\n')), 1);
  });

  it('gives the line where the shorter file ends', () => {
    assert.equal(findDifferentLine(BUILT, Buffer.from('one\ntwo\n')), 3);
    assert.equal(findDifferentLine(BUILT, Buffer.from('one\ntwo\nthree\nfour\n')), 4);
    assert.equal(findDifferentLine(BUILT, Buffer.alloc(0)), 1);
  });
});
