import { buildPromptSnapshot } from './build-prompt-snapshot.js';
import { CONTRACT_RUNTIME_VERSION } from './contract.js';
import { isObject } from './is-object.js';
import { loadScenarios } from './load-scenarios.js';
import { PARSE_OPTIONS, parseSource } from './parse-source.js';
import { checkPromptBudgets } from './prompt-budget.js';
import { readRoles } from './read-roles.js';
import { simulateFileScenario } from './simulate-file-scenario.js';
import { UsageError } from './usage-error.js';
import { checkScriptFile } from './validate.js';

/** @typedef {import('./build-prompt-snapshot.js').PromptVariant} PromptVariant */
/** @typedef {import('./build-prompt-snapshot.js').RolePromptSize} RolePromptSize */
/** @typedef {import('./build-prompt-snapshot.js').PromptBudgetProblem} PromptBudgetProblem */
/** @typedef {import('./list-unread-scenarios.js').UnreadScenario} UnreadScenario */

// A misspelled key such as `scenario` would otherwise read as a missing scenarios file.
const SNAPSHOT_OPTION_KEYS = new Set(['script', 'scenarios', 'promptBudgets']);

/**
 * @typedef {object} SnapshotOptions
 * @property {string} script The workflow script, as `validate()` takes it.
 * @property {string} scenarios The scenarios file, relative to the working directory or absolute.
 * @property {Record<string, number>} [promptBudgets] By role, the most characters its largest prompt may hold.
 */

/**
 * @typedef {object} SnapshotResult
 * @property {boolean} ok True when no scenario is unread, a scenario makes a call and promptBudgetProblems is empty.
 * @property {string} script The script, as `validate()` names it.
 * @property {string} runtime The Claude Code version the simulations stand in for.
 * @property {PromptVariant[] | null} variants Null when a scenario is unread.
 * @property {RolePromptSize[]} roles In the order each role's first call was made.
 * @property {number} callCount The count of calls of every scenario.
 * @property {string | null} digest The SHA-256, as lowercase hex, of the label, the prompt and the schema of
 *   every call, or null when a scenario is unread.
 * @property {PromptBudgetProblem[]} promptBudgetProblems [] when no promptBudgets is given.
 * @property {UnreadScenario[]} unread Each scenario whose simulation stopped or whose script was refused, in file order.
 */

/**
 * Simulates every scenario of a scenarios file against one workflow script and lists the distinct prompts of
 * each role, and writes and prints nothing.
 * Rejects with a UsageError for options of another shape, and for each problem that `loadScenarios()` and
 * `simulate()` reject for. A rejection of `simulate()` names the scenario and the scenarios file.
 * @param {SnapshotOptions} options
 * @returns {Promise<SnapshotResult>}
 */
export async function snapshot(options = /** @type {SnapshotOptions} */ ({})) {
  const { script, scenarios, promptBudgets } = readOptions(options);
  const fileScenarios = await loadScenarios(scenarios);
  const { scriptPath, text, findings } = await checkScriptFile(script);
  // A refused script does not run, so each of its scenarios is unread and no reader needs its tree.
  const roles = findings.length === 0 ? readRoles(parseSource(/** @type {string} */ (text), PARSE_OPTIONS)) : [];
  const runs = [];

  for (const fileScenario of fileScenarios) runs.push({ name: fileScenario.name, trace: await simulateFileScenario(script, fileScenario, scenarios) });
  const promptSnapshot = buildPromptSnapshot({ roles, runs, promptBudgets });
  const ok = promptSnapshot.unread.length === 0 && promptSnapshot.callCount > 0 && promptSnapshot.promptBudgetProblems.length === 0;

  return { ok, script: scriptPath, runtime: CONTRACT_RUNTIME_VERSION, ...promptSnapshot };
}

/**
 * @param {unknown} options
 * @returns {{ script: string, scenarios: string, promptBudgets: Record<string, number> | null }}
 */
function readOptions(options) {
  if (!isObject(options)) throw new UsageError('snapshot() takes an options object');
  const unknownKey = Object.keys(options).find((key) => !SNAPSHOT_OPTION_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`snapshot() takes no option ${unknownKey}`);
  const { script, scenarios, promptBudgets } = options;
  if (typeof script !== 'string' || script === '') throw new UsageError('snapshot() needs script, the path of a workflow script');
  if (typeof scenarios !== 'string' || scenarios === '') throw new UsageError('snapshot() needs scenarios, the path of a scenarios file');
  return { script, scenarios, promptBudgets: promptBudgets === undefined ? null : readPromptBudgets(promptBudgets) };
}

/**
 * @param {unknown} promptBudgets
 * @returns {Record<string, number>} A copy, so a change the caller makes during the simulations reaches no result.
 */
function readPromptBudgets(promptBudgets) {
  checkPromptBudgets(promptBudgets, 'snapshot()');
  return Object.fromEntries(Object.entries(promptBudgets));
}
