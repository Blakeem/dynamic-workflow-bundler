const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/**
 * Drops a leading byte order mark and reads every CRLF or lone CR as LF.
 * A CR is a line terminator wherever JavaScript allows one, and a template literal reads it as LF,
 * so the rewrite leaves every value unchanged.
 * @param {string} text
 * @returns {string}
 */
export function normalizeSourceText(text) {
  return normalizeTextFile(text).replace(/\r/g, '\n');
}

/**
 * Drops a leading byte order mark and reads every CRLF as LF. A lone CR is part of a text file's value.
 * @param {string} text
 * @returns {string}
 */
export function normalizeTextFile(text) {
  const withoutMark = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  return withoutMark.replace(/\r\n/g, '\n');
}
