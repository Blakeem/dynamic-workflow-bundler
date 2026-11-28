import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeCell } from '../src/escape-cell.js';

describe('escapeCell', () => {
  it('escapes each Markdown inline mark, the cell bound and each HTML character', () => {
    assert.equal(escapeCell('a|b'), 'a\\|b');
    assert.equal(escapeCell('\\`*_~[]'), '\\\\\\`\\*\\_\\~\\[\\]');
    assert.equal(escapeCell('<b> & c'), '&lt;b&gt; &amp; c');
  });

  it('writes the text on one line, with each white space run as one space and no space at either end', () => {
    assert.equal(escapeCell('  a\n\tb  '), 'a b');
  });

  it('keeps text that holds no such character', () => {
    assert.equal(escapeCell('passes at once'), 'passes at once');
  });
});
