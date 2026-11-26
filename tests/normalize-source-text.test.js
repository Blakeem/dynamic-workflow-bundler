import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSourceText } from '../src/normalize-source-text.js';

describe('normalizeSourceText', () => {
  it('drops a leading byte order mark and reads CRLF and a lone CR as LF', () => {
    assert.equal(normalizeSourceText('\uFEFFa\r\nb\rc\n'), 'a\nb\nc\n');
  });

  it('keeps a byte order mark that does not start the text', () => {
    assert.equal(normalizeSourceText('a\uFEFF'), 'a\uFEFF');
  });
});
