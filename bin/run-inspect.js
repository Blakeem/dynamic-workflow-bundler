import { parseArgs } from 'node:util';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { createInspection } from '../src/create-inspection.js';
import { formatHiddenCharacters } from '../src/format-hidden-characters.js';
import { formatInspectionText } from '../src/format-inspection-text.js';
import { CONFIG_FILES_TEXT } from '../src/load-config.js';
import { selectInspectScenario } from '../src/select-scenarios.js';
import { findScriptTarget } from './find-script-target.js';
import { findScriptUsageProblem, ONE_SCRIPT_PROBLEM } from './find-script-usage-problem.js';
import { loadTargetScenarios } from './load-target-scenarios.js';
import { EXIT_FINDINGS, EXIT_SUCCESS, printCommandFailure, printResult, printUsageError } from './print-result.js';
import { simulateScenario } from './simulate-scenario.js';

const CALL_INDEX_PATTERN = /^\d+$/;

const INSPECT_USAGE = `Usage: dwfb inspect <script> [--scenarios <file>] [--scenario <name>] [--call <index>] [options]

Runs a workflow script against one scenario of a scenarios file with no model call, as the runtime of
Claude Code ${CONTRACT_RUNTIME_VERSION} runs it, and prints the events of the simulation in order, or one call in full. With
no --scenarios, reads the scenarios file of the workflow of the config file whose out is the script.

Options:
  --scenarios <file>   Read the scenarios of the script from this file.
  --scenario <name>    Run the scenario of this name. A scenarios file of one scenario needs none.
  --call <index>       Print the call of this index in full. The first call is 0.
  --config <path>      Read this config file in place of ${CONFIG_FILES_TEXT}.
  --json               Print the result as one JSON object.
  --help               Print this help.
`;

const INSPECT_OPTIONS = Object.freeze({
  scenarios: { type: 'string' },
  scenario: { type: 'string' },
  call: { type: 'string' },
  config: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
});

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function runInspect(args) {
  let parsed = null;
  let problem = null;
  let simulation = null;
  let isRefused = false;
  let inspection = null;

  try {
    parsed = parseArgs({ args, options: INSPECT_OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    return printUsageError('dwfb inspect', `${error.message}\n\n${INSPECT_USAGE}`);
  }

  const { values, positionals } = parsed;
  const [script] = positionals;
  if (values.help) return printResult(INSPECT_USAGE);
  // inspect needs a script even with no --scenarios, so the shared check of --scenarios with no script never fires here.
  if (script === undefined) return printUsageError('dwfb inspect', `${ONE_SCRIPT_PROBLEM}.\n\n${INSPECT_USAGE}`);
  problem = findScriptUsageProblem(values, positionals, 'inspects') ?? findEmptyInspectValueProblem(values);
  if (problem !== null) return printUsageError('dwfb inspect', `${problem}.\n\n${INSPECT_USAGE}`);
  if (values.call !== undefined && !CALL_INDEX_PATTERN.test(values.call)) {
    return printUsageError('dwfb inspect', `The call "${formatHiddenCharacters(values.call)}" is not a whole number written in digits.\n\n${INSPECT_USAGE}`);
  }

  try {
    simulation = await simulateTarget(await findScriptTarget(script, values.scenarios, values.config), values.scenario);
    isRefused = simulation.trace.end.kind === 'refused';
    inspection = createInspection(simulation.trace, values.call === undefined ? undefined : Number(values.call));
  } catch (error) {
    return printCommandFailure('dwfb inspect', error);
  }

  const exitCode = isRefused ? EXIT_FINDINGS : EXIT_SUCCESS;
  if (values.json) return printResult(`${JSON.stringify({ ok: !isRefused, ...inspection }, null, 2)}\n`, exitCode);
  return printResult(formatInspectionText(simulation, inspection), exitCode);
}

/**
 * @param {{ scenario?: string, call?: string }} values
 * @returns {string | null} The usage error of an empty `--scenario` or `--call`, with no full stop, or null for none.
 */
function findEmptyInspectValueProblem(values) {
  if (values.scenario === '') return 'Name the scenario with --scenario <name>';
  if (values.call === '') return 'Name the call with --call <index>';
  return null;
}

/**
 * @param {import('./find-script-target.js').SimulationTarget} target
 * @param {string | undefined} name The name `--scenario` gives.
 * @returns {Promise<import('../src/format-trace-line.js').Simulation>} The simulation of the one scenario that
 *   `dwfb inspect` runs.
 */
async function simulateTarget(target, name) {
  const fileScenario = selectInspectScenario(await loadTargetScenarios(target), name, target.scenariosFile);

  return simulateScenario(target.script, fileScenario, target.scenariosFile);
}
