/** @typedef {import('./finding.js').Finding} Finding */

/**
 * @param {Finding} finding
 * @returns {string} `<file>:<line>:<column> <rule id> <what is wrong>. <how to fix it>.`
 */
export function formatFinding(finding) {
  return `${finding.file}:${finding.line}:${finding.column} ${finding.rule} ${finding.message}. ${finding.fix}.`;
}
