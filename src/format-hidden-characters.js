// A terminal shows none of these: the control and format characters, the line separator (Zl) and the
// paragraph separator (Zp). An output in UTF-8 cannot hold a lone surrogate (Cs), which the `u` flag matches
// only outside a pair.
const HIDDEN_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;
// A UTF-8 file cannot hold a lone surrogate, and git reads a file that holds U+0000 as binary.
const UNWRITABLE_CHARACTER_PATTERN = /[\p{Cs}\u0000]/gu;

/**
 * Writes each character a terminal does not show as its JavaScript escape, such as \u{0000}. The closing brace
 * ends the escape, so a hex digit that follows it reads as text. The result holds no such character, so a
 * second call gives the same text.
 * @param {string} text
 * @returns {string}
 */
export function formatHiddenCharacters(text) {
  return text.replace(HIDDEN_CHARACTER_PATTERN, formatCharacterEscape);
}

/**
 * Writes each lone surrogate and each U+0000 as its JavaScript escape, such as \u{D83D}, and every other
 * character as it is, so that a document file holds the text and git reads the file as text.
 * @param {string} text
 * @returns {string}
 */
export function formatUnwritableCharacters(text) {
  return text.replace(UNWRITABLE_CHARACTER_PATTERN, formatCharacterEscape);
}

/**
 * @param {string} character One code point.
 * @returns {string} The JavaScript escape of the character, such as \u{D83D}.
 */
function formatCharacterEscape(character) {
  return `\\u{${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`;
}
