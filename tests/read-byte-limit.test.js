import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatOversizeReason, READ_BYTE_LIMIT } from '../src/read-byte-limit.js';

describe('formatOversizeReason', () => {
  it('names the size and the limit', () => {
    assert.equal(formatOversizeReason(READ_BYTE_LIMIT + 1), '2097153 bytes, which is more than the 2097152 bytes dwfb reads');
  });
});
