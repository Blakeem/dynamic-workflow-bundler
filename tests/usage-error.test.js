import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UsageError } from '../src/usage-error.js';

describe('UsageError', () => {
  it('is an Error named UsageError that carries its message', () => {
    const error = new UsageError('Name one entry file');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'UsageError');
    assert.equal(error.message, 'Name one entry file');
  });
});
