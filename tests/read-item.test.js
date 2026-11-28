import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readItem } from '../src/read-item.js';

describe('readItem', () => {
  it('gives the label after the role, with no separator at its start', () => {
    assert.equal(readItem('review:u1', 'review'), 'u1');
    assert.equal(readItem('review / u1', 'review'), 'u1');
  });

  it('leaves out a round marker at the end of the label', () => {
    assert.equal(readItem('dev a r2', 'dev'), 'a');
    assert.equal(readItem('verify r1', 'verify'), '');
    assert.equal(readItem('dev:a:r12', 'dev'), 'a');
  });

  it('gives an empty item for a label that is its role', () => {
    assert.equal(readItem('summary', 'summary'), '');
  });
});
