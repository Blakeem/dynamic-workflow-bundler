/**
 * @param {{ file: string | null, sourceLine: number | null }} lineSource The source of one built line, such as
 *   a FirstDifference.
 * @returns {string}
 */
export function formatLineSource({ file, sourceLine }) {
  if (sourceLine !== null) return `The line comes from ${file}:${sourceLine}.`;
  if (file !== null) return `The build adds the line for ${file}.`;
  return 'The build adds the line.';
}
