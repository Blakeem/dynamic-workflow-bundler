import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatHiddenCharacters } from '../src/format-hidden-characters.js';

describe('formatHiddenCharacters', () => {
  it('writes each control, format, line separator and paragraph separator character as its JavaScript escape', () => {
    assert.equal(formatHiddenCharacters('\u0000\t\u001B\u200C\u200D\uFEFF\u2028\u2029'), '\\u{0000}\\u{0009}\\u{001B}\\u{200C}\\u{200D}\\u{FEFF}\\u{2028}\\u{2029}');
    assert.equal(formatHiddenCharacters(String.fromCodePoint(0x1d173)), '\\u{1D173}');
  });

  it('ends each escape, so a hex digit that follows reads as text', () => {
    assert.equal(formatHiddenCharacters('A\u200DB'), 'A\\u{200D}B');
  });

  it('keeps every character a terminal shows, and gives the same text on a second call', () => {
    const text = 'a § é 名 😀 \\u{200D}';

    assert.equal(formatHiddenCharacters(text), text);
    assert.equal(formatHiddenCharacters(formatHiddenCharacters('a\u0000b')), 'a\\u{0000}b');
    assert.equal(formatHiddenCharacters(''), '');
  });
});
