/** @typedef {'fresh' | 'stale' | 'missing'} DocumentCheck How the file of one document compares with the document. */

/**
 * @typedef {'wrote' | 'unchanged' | DocumentCheck} DocumentFileOutcome What a command did with the file of one
 *   document: wrote it or left it unchanged, or with `--check`, how the file compares.
 */

/**
 * @param {DocumentFileOutcome} outcome
 * @param {string} fileLabel The file, as formatRealDisplayPath gives it.
 * @param {string} documentName Such as `flow map`.
 * @param {string} script The script, as the result of the command names it.
 * @returns {string} The line `dwfb map` or `dwfb snapshot` prints for the file, with no line end.
 */
export function formatDocumentFileLine(outcome, fileLabel, documentName, script) {
  if (outcome === 'wrote') return `Wrote ${fileLabel}.`;
  if (outcome === 'unchanged') return `Unchanged ${fileLabel}.`;
  if (outcome === 'fresh') return `Fresh ${fileLabel}.`;
  if (outcome === 'missing') return `Stale ${fileLabel}: the file is missing.`;
  return `Stale ${fileLabel}: the file differs from the ${documentName} of ${script}.`;
}
