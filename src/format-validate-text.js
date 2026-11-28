import { formatFinding } from './format-finding.js';

/**
 * @param {import('./validate.js').ValidateResult[]} results In the order checked.
 * @param {string[]} skipped The out of each workflow that sets `validate: false`, relative to the working
 *   directory's real path.
 * @returns {string} The lines a person reads: those of each checked script, then one line per skipped workflow.
 */
export function formatValidateText(results, skipped) {
  return `${results.map(formatScriptText).join('')}${skipped.map(formatSkippedText).join('')}`;
}

/**
 * @param {import('./validate.js').ValidateResult} result
 * @returns {string} The lines a person reads for one script.
 */
function formatScriptText(result) {
  if (result.ok) return `${result.script} breaks no rule of the contract measured on Claude Code ${result.runtime}.\n`;
  return result.findings.map((finding) => `${formatFinding(finding)}\n`).join('');
}

/**
 * @param {string} out The out of a skipped workflow.
 * @returns {string} The line a person reads for one skipped workflow.
 */
function formatSkippedText(out) {
  return `Skipped ${out}, since its workflow sets validate: false.\n`;
}
