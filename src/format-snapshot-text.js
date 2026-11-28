import { formatCount } from './format-count.js';
import { formatFinding } from './format-finding.js';
import { formatHiddenCharacters } from './format-hidden-characters.js';

/** @typedef {import('./snapshot.js').SnapshotResult} SnapshotResult */
/** @typedef {import('./snapshot.js').RolePromptSize} RolePromptSize */
/** @typedef {import('./snapshot.js').PromptBudgetProblem} PromptBudgetProblem */

/**
 * Writes what `dwfb snapshot` prints for one script whose prompt snapshot goes to a file or cannot be made, and
 * reads no disk and prints nothing.
 * @param {SnapshotResult} result
 * @param {import('./finding.js').Finding[]} findings The findings of a refused script, else [].
 * @param {string | null} fileLine The line of the prompt snapshot file, as formatDocumentFileLine gives it, or null
 *   for a script with no prompt snapshot.
 * @returns {string} Each line with its line end: the findings, a line per unread scenario or the line of a script
 *   with no call, the file line, a line per role, then a line per prompt budget problem.
 */
export function formatSnapshotText(result, findings, fileLine) {
  const { script, unread, callCount, roles, promptBudgetProblems } = result;
  const lines = [...findings.map(formatFinding), ...unread.map(({ scenario, reason }) => `${script} ${formatHiddenCharacters(scenario)}: not read, since ${reason}.`)];

  if (unread.length === 0 && callCount === 0) lines.push(`${script}: no prompt snapshot, since no scenario makes an agent() call.`);
  if (fileLine !== null) lines.push(fileLine);
  lines.push(...roles.map(formatRoleLine), ...promptBudgetProblems.map((problem) => formatProblemLine(script, problem)));

  return lines.map((line) => `${line}\n`).join('');
}

/**
 * @param {RolePromptSize} roleSize
 * @returns {string}
 */
function formatRoleLine({ role, characters, promptBudget }) {
  const promptBudgetText = promptBudget === null ? '' : `, prompt budget ${promptBudget}`;

  return `  ${formatHiddenCharacters(role)}: ${formatCount(characters, 'character')}${promptBudgetText}`;
}

/**
 * @param {string} script
 * @param {PromptBudgetProblem} problem
 * @returns {string}
 */
function formatProblemLine(script, problem) {
  const start = `${script} ${formatHiddenCharacters(problem.role)}`;

  if (problem.kind === 'over') return `${start}: the largest prompt has ${formatCount(problem.characters, 'character')}, ${problem.characters - problem.promptBudget} over its prompt budget of ${problem.promptBudget}.`;
  if (problem.kind === 'missing') return `${start}: the largest prompt has ${formatCount(problem.characters, 'character')} and the role has no prompt budget, so give it one in promptBudgets.`;
  return `${start}: promptBudgets names this role, and no scenario makes a call of it.`;
}
