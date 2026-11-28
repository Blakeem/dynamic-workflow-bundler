import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeCell } from '../src/escape-cell.js';

describe('escapeCell', () => {
  it('escapes each Markdown inline mark, the cell bound and each HTML character', () => {
    assert.equal(escapeCell('a|b'), 'a\\|b');
    assert.equal(escapeCell('\\`*_~[]'), '\\\\\\`\\*\\_\\~\\[\\]');
    assert.equal(escapeCell('<b> & c'), '&lt;b&gt; &amp; c');
  });

  it('writes each $ inside a span tag, which GitHub reads as no math delimiter, after the HTML escapes', () => {
    assert.equal(escapeCell('costs $n$ calls'), 'costs <span>$</span>n<span>$</span> calls');
    assert.equal(escapeCell('$& <$>'), '<span>$</span>&amp; &lt;<span>$</span>&gt;');
  });

  it('writes a lone surrogate and a U+0000 as their escape, whose backslash reads as text', () => {
    assert.equal(escapeCell('a\uD83Db\u0000c😀'), 'a\\\\u{D83D}b\\\\u{0000}c😀');
  });

  it('writes the text on one line, with each white space run as one space and no space at either end', () => {
    assert.equal(escapeCell('  a\n\tb  '), 'a b');
  });

  it('keeps text that holds no such character', () => {
    assert.equal(escapeCell('passes at once'), 'passes at once');
  });
});
