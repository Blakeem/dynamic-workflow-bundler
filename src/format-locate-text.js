import { formatFinding } from './format-finding.js';
import { formatLineSource } from './format-line-source.js';

/**
 * @param {import('./locate.js').LocateResult} result
 * @returns {string} The lines a person reads.
 */
export function formatLocateText(result) {
  if (!result.ok) return result.findings.map((finding) => `${formatFinding(finding)}\n`).join('');
  if (result.generated) return `${formatLineSource({ file: result.file, sourceLine: null })} It has no source line.\n`;
  return `${result.file}:${result.line}:${result.column}\n${result.text}\n`;
}
