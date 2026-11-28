import assert from 'node:assert/strict';

/**
 * @param {string} text
 * @param {string} fragment Text that the text holds.
 * @returns {{ line: number, column: number }} The 1-based place of the first character of the fragment's first copy.
 */
export function placeOf(text, fragment) {
  const offset = text.indexOf(fragment);
  const lines = text.slice(0, offset).split('\n');

  assert.notEqual(offset, -1, fragment);
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}
