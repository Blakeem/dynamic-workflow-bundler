import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatLineSource } from '../src/format-line-source.js';

describe('formatLineSource', () => {
  it('names the source line a built line comes from', () => {
    assert.equal(formatLineSource({ file: 'src/a.js', sourceLine: 4 }), 'The line comes from src/a.js:4.');
  });

  it('names the source a line the build adds belongs to, and no source for a line of none', () => {
    assert.equal(formatLineSource({ file: 'src/a.js', sourceLine: null }), 'The build adds the line for src/a.js.');
    assert.equal(formatLineSource({ file: null, sourceLine: null }), 'The build adds the line.');
  });
});
