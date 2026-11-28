import { buildCoverage } from './build-coverage.js';
import { CONTRACT_RUNTIME_VERSION } from './contract.js';
import { isObject } from './is-object.js';
import { loadScenarios } from './load-scenarios.js';
import { simulateFileScenario } from './simulate-file-scenario.js';
import { UsageError } from './usage-error.js';
import { checkScriptFile } from './validate.js';

/** @typedef {import('./build-coverage.js').RoleCoverage} RoleCoverage */
/** @typedef {import('./build-coverage.js').ThrowSiteCoverage} ThrowSiteCoverage */
/** @typedef {import('./build-coverage.js').EndStateCoverage} EndStateCoverage */
/** @typedef {import('./build-coverage.js').PhaseCoverage} PhaseCoverage */
/** @typedef {import('./list-unread-scenarios.js').UnreadScenario} UnreadScenario */
/** @typedef {import('./finding.js').Finding} Finding */

// A misspelled key such as `scenario` would otherwise read as a missing scenarios file.
const COVER_OPTION_KEYS = new Set(['script', 'scenarios']);

/**
 * @typedef {object} CoverOptions
 * @property {string} script The workflow script, as `validate()` takes it.
 * @property {string} scenarios The scenarios file, relative to the working directory or absolute.
 */

/**
 * @typedef {object} CoverageResult
 * @property {boolean} ok True when `unread` and `findings` are both empty.
 * @property {string} script The script, as `validate()` names it.
 * @property {string} runtime The Claude Code version the simulations stand in for.
 * @property {number} scenarioCount The count of scenarios of the scenarios file.
 * @property {RoleCoverage[] | null} roles In source order. Null when a scenario is unread.
 * @property {ThrowSiteCoverage[] | null} throwSites In source order. Null when a scenario is unread.
 * @property {EndStateCoverage[] | null} endStates In source order. Null when a scenario is unread, or for a
 *   script with no `// @end-states` comment that declares end states.
 * @property {PhaseCoverage[] | null} phases Each element of `meta.phases` whose title is a string of 1 or more
 *   characters, in its order. Null when a scenario is unread.
 * @property {Finding[]} findings Each gap, each misplaced `// @end-states` or `// @unreached` comment, each
 *   `// @unreached` comment with no reason and each marked throw site that a scenario reaches, sorted by line,
 *   then column. Each finding's `file` is `script`. For a refused script, its contract findings alone.
 * @property {UnreadScenario[]} unread Each scenario whose simulation stopped or whose script was refused, in file order.
 */

/**
 * Simulates every scenario of a scenarios file against one workflow script and reports each role, throw site,
 * declared end state and phase of the script that no scenario reaches, and writes and prints nothing.
 * Rejects with a UsageError for options of another shape, and for each problem that `loadScenarios()` and
 * `simulate()` reject for. A rejection of `simulate()` names the scenario and the scenarios file.
 * @param {CoverOptions} options
 * @returns {Promise<CoverageResult>}
 */
export async function cover(options = /** @type {CoverOptions} */ ({})) {
  const { script, scenarios } = readOptions(options);
  const fileScenarios = await loadScenarios(scenarios);
  const { scriptPath, text, findings } = await checkScriptFile(script);
  const runs = [];

  for (const fileScenario of fileScenarios) {
    const { name, endState } = fileScenario;

    runs.push({ name, endState, trace: await simulateFileScenario(script, fileScenario, scenarios) });
  }
  const coverage = buildCoverage({ file: scriptPath, text, contractFindings: findings, runs });
  const ok = coverage.unread.length === 0 && coverage.findings.length === 0;

  return { ok, script: scriptPath, runtime: CONTRACT_RUNTIME_VERSION, scenarioCount: runs.length, ...coverage };
}

/**
 * @param {unknown} options
 * @returns {CoverOptions}
 */
function readOptions(options) {
  if (!isObject(options)) throw new UsageError('cover() takes an options object');
  const unknownKey = Object.keys(options).find((key) => !COVER_OPTION_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`cover() takes no option ${unknownKey}`);
  const { script, scenarios } = options;
  if (typeof script !== 'string' || script === '') throw new UsageError('cover() needs script, the path of a workflow script');
  if (typeof scenarios !== 'string' || scenarios === '') throw new UsageError('cover() needs scenarios, the path of a scenarios file');
  return { script, scenarios };
}
