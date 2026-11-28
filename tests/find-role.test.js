import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findRole } from '../src/find-role.js';

describe('findRole', () => {
  it('gives the longest role the label starts with', () => {
    assert.equal(findRole('review:u1', ['review']), 'review');
    assert.equal(findRole('review-fix:u1', ['review', 'review-fix', 'fix']), 'review-fix');
    assert.equal(findRole('review-fix:u1', ['review-fix', 'review']), 'review-fix');
  });

  it('gives null for a label that starts with no role, and for no label', () => {
    assert.equal(findRole('note', ['review']), null);
    assert.equal(findRole('note', []), null);
    assert.equal(findRole(null, ['review']), null);
  });
});
