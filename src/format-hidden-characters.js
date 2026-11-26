// A terminal shows none of these: the control and format characters, the line separator (Zl) and the
// paragraph separator (Zp).
const HIDDEN_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Writes each character a terminal does not show as its JavaScript escape, such as \u{0000}. The closing brace
 * ends the escape, so a hex digit that follows it reads as text. The result holds no such character, so a
 * second call gives the same text.
 * @param {string} text
 * @returns {string}
 */
export function formatHiddenCharacters(text) {
  return text.replace(HIDDEN_CHARACTER_PATTERN, (character) => `\\u{${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`);
}
