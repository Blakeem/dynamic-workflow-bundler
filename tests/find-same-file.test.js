import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findSameFile } from '../src/find-same-file.js';

describe('findSameFile', () => {
  it('gives the first entry of the same path before an entry that differs only in letter case', () => {
    const lower = { file: '/w/flow.js', label: 'lower' };
    const upper = { file: '/w/Flow.js', label: 'upper' };
    assert.equal(findSameFile([upper, lower], '/w/flow.js'), lower);
    assert.equal(findSameFile([upper], '/w/flow.js'), upper);
  });

  it('gives undefined for a path no entry names', () => {
    assert.equal(findSameFile([{ file: '/w/flow.js' }], '/w/other.js'), undefined);
  });
});
