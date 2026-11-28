import { formatCount } from './format-count.js';
import { formatFinding } from './format-finding.js';
import { formatHiddenCharacters } from './format-hidden-characters.js';

/** @typedef {import('./cover.js').CoverageResult} CoverageResult */
/** @typedef {{ reached: boolean, unreachedReason: string | null }} MarkedCoverage A role or a throw site. */

const NO_END_STATES_LINE = '  end states: none declared with // @end-states';

/**
 * Writes what `dwfb cover` prints, and reads no disk and prints nothing.
 * @param {CoverageResult[]} results In the order covered.
 * @returns {string} Each line with its line end. For each script: its findings, a line per unread scenario, then
 *   for a script with no unread scenario its count of scenarios and a line per kind with how many a scenario reaches.
 */
export function formatCoverText(results) {
  return results.flatMap(formatScriptLines).map((line) => `${line}\n`).join('');
}

/**
 * @param {CoverageResult} result
 * @returns {string[]}
 */
function formatScriptLines(result) {
  const { script, scenarioCount, roles, throwSites, endStates, phases, findings, unread } = result;
  const lines = [...findings.map(formatFinding), ...unread.map(({ scenario, reason }) => `${script} ${formatHiddenCharacters(scenario)}: not read, since ${reason}.`)];

  // cover() gives null lists when a scenario is unread, since a count over a part of the scenarios would report a gap that is none.
  if (unread.length > 0) return lines;
  lines.push(
    `${script}: ${formatCount(scenarioCount, 'scenario')}`,
    formatMarkedReachLine('roles', /** @type {MarkedCoverage[]} */ (roles)),
    formatMarkedReachLine('throw sites', /** @type {MarkedCoverage[]} */ (throwSites)),
    endStates === null ? NO_END_STATES_LINE : formatReachLine('end states', endStates),
    formatReachLine('phases', /** @type {{ reached: boolean }[]} */ (phases)),
  );

  return lines;
}

/**
 * @param {string} kind The plural of the kind, such as `roles`.
 * @param {{ reached: boolean }[]} parts
 * @returns {string}
 */
function formatReachLine(kind, parts) {
  return `  ${kind}: ${parts.filter(({ reached }) => reached).length} of ${parts.length} reached`;
}

/**
 * @param {string} kind The plural of the kind, such as `throw sites`.
 * @param {MarkedCoverage[]} coverages
 * @returns {string} The reach of the roles or throw sites with no `// @unreached` mark, then the count of marked
 *   ones when there is one, since a marked role or throw site counts as neither reached nor missed.
 */
function formatMarkedReachLine(kind, coverages) {
  const unmarkedCoverages = coverages.filter(({ unreachedReason }) => unreachedReason === null);
  const markedCount = coverages.length - unmarkedCoverages.length;
  const markedText = markedCount === 0 ? '' : `, ${markedCount} marked unreached`;

  return `${formatReachLine(kind, unmarkedCoverages)}${markedText}`;
}
