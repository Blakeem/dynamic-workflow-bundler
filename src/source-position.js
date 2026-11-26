/**
 * Gives the 1-based line and column of an offset, counting only LF as a line break.
 * Acorn also counts U+2028 and U+2029, which no editor shows as a line break.
 * @param {string} text
 * @param {number} offset
 * @returns {{ line: number, column: number }}
 */
export function findPosition(text, offset) {
  let line = 1;
  let lineStart = 0;
  let breakIndex = text.indexOf('\n');

  while (breakIndex !== -1 && breakIndex < offset) {
    line += 1;
    lineStart = breakIndex + 1;
    breakIndex = text.indexOf('\n', lineStart);
  }

  return { line, column: offset - lineStart + 1 };
}
