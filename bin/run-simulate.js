import { parseArgs } from 'node:util';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatSimulateJson } from '../src/format-simulate-json.js';
import { formatSimulateText } from '../src/format-simulate-text.js';
import { CONFIG_FILES_TEXT } from '../src/load-config.js';
import { selectScenarios } from '../src/select-scenarios.js';
import { findConfigTargets } from './find-config-targets.js';
import { findScriptTarget } from './find-script-target.js';
import { findScriptUsageProblem } from './find-script-usage-problem.js';
import { loadTargetScenarios } from './load-target-scenarios.js';
import { EXIT_FINDINGS, EXIT_SUCCESS, printCommandFailure, printResult, printUsageError } from './print-result.js';
import { simulateScenario } from './simulate-scenario.js';

const SIMULATE_USAGE = `Usage: dwfb simulate [<script>] [--scenarios <file>] [options]

Runs a workflow script against each scenario of a scenarios file with no model call, as the runtime of
Claude Code ${CONTRACT_RUNTIME_VERSION} runs it, and prints how each simulation ended. A scenario passes
when its simulation ends as its expect says, which is returned by default. With no script, runs the out of
each workflow of the config file that has scenarios against its scenarios file. With a script and no
--scenarios, reads the scenarios file of the workflow of the config file whose out is the script.

Options:
  --scenarios <file>   Read the scenarios of the script from this file.
  --scenario <name>    Run only the scenario of this name.
  --config <path>      Read this config file in place of ${CONFIG_FILES_TEXT}.
  --json               Print the result as one JSON object.
  --help               Print this help.
`;

const SIMULATE_OPTIONS = Object.freeze({
  scenarios: { type: 'string' },
  scenario: { type: 'string' },
  config: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
});

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function runSimulate(args) {
  let parsed = null;
  let problem = null;
  let targets = null;
  const simulations = [];

  try {
    parsed = parseArgs({ args, options: SIMULATE_OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    return printUsageError('dwfb simulate', `${error.message}\n\n${SIMULATE_USAGE}`);
  }

  const { values, positionals } = parsed;
  const [script] = positionals;
  if (values.help) return printResult(SIMULATE_USAGE);
  problem = findScriptUsageProblem(values, positionals, 'simulates', {
    findEmptyValueProblem: () => (values.scenario === '' ? 'Name the scenario with --scenario <name>' : null),
    findMissingScriptProblem: () => (script === undefined && values.scenario !== undefined ? 'Name the script that --scenario simulates' : null),
  });
  if (problem !== null) return printUsageError('dwfb simulate', `${problem}.\n\n${SIMULATE_USAGE}`);

  // Every simulation runs before any result prints, so a usage error in a later simulation prints no result.
  try {
    targets = script === undefined ? await findConfigTargets(values.config) : [await findScriptTarget(script, values.scenarios, values.config)];
    for (const target of targets) {
      const fileScenarios = selectScenarios(await loadTargetScenarios(target), values.scenario, target.scenariosFile);
      for (const fileScenario of fileScenarios) simulations.push(await simulateScenario(target.script, fileScenario, target.scenariosFile));
    }
  } catch (error) {
    return printCommandFailure('dwfb simulate', error);
  }

  const isSuccess = simulations.every((simulation) => simulation.passed);
  const exitCode = isSuccess ? EXIT_SUCCESS : EXIT_FINDINGS;
  if (values.json) return printResult(`${JSON.stringify(formatSimulateJson(simulations, isSuccess), null, 2)}\n`, exitCode);
  return printResult(formatSimulateText(simulations), exitCode);
}
