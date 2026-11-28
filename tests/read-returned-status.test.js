import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readReturnedStatus } from '../src/read-returned-status.js';

describe('readReturnedStatus', () => {
  it('gives the status of a returned object when it is a string of 1 or more characters', () => {
    assert.equal(readReturnedStatus({ status: 'done', other: 1 }), 'done');
  });

  it('gives null for an empty status, a status of another type, an object with no status and a value that is no object', () => {
    for (const value of [{ status: '' }, { status: 3 }, { status: null }, {}, 'done', null, ['done']]) {
      assert.equal(readReturnedStatus(value), null, JSON.stringify(value));
    }
  });
});
