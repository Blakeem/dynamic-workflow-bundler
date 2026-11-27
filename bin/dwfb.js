#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from '../src/build.js';
import { formatBuildCommand } from '../src/build-command.js';
import { AGENT_CALL_LIMIT, CONTRACT_RUNTIME_VERSION, isPastCallLimit } from '../src/contract.js';
import { createInspection } from '../src/create-inspection.js';
import { formatDisplayPath } from '../src/display-path.js';
import { findConfigWorkflows } from '../src/find-config-workflows.js';
import { formatCallName } from '../src/find-scripted-return.js';
import { formatFinding } from '../src/format-finding.js';
import { formatHiddenCharacters } from '../src/format-hidden-characters.js';
import { formatSimulationEnd } from '../src/format-simulation-end.js';
import { CONFIG_FILES_TEXT, loadCommandConfig } from '../src/load-config.js';
import { loadScenarios } from '../src/load-scenarios.js';
import { MISSING_FILE_CODES } from '../src/load-sources.js';
import { locate } from '../src/locate.js';
import { findRealPath, formatRealDisplayPath } from '../src/real-path.js';
import { simulate } from '../src/simulate.js';
import { UsageError } from '../src/usage-error.js';
import { validate } from '../src/validate.js';
import { writeScript } from '../src/write-script.js';

const EXIT_SUCCESS = 0;
const EXIT_FINDINGS = 1;
const EXIT_FAILURE = 2;
const SCRIPT_POSITION_PATTERN = /^(?<line>\d+)(?::(?<column>\d+))?$/;
const CALL_INDEX_PATTERN = /^\d+$/;
const SCENARIOS_FILE_RECOVERY = 'so name the scenarios file with --scenarios <file>';
const SCENARIOS_CONFIG_CONFLICT = 'Name --scenarios or --config, not both, since a named scenarios file needs no config file';
const LATE_CALL_LINE = 'no return, since the script had settled and the scenario holds no usable scripted return for this call';
const LATE_CAP_LINE = `no return, since the script had settled and the call came after the cap of ${AGENT_CALL_LIMIT} agent() calls`;

const MAIN_USAGE = `Usage: dwfb <command> [options]

Commands:
  build [<entry>] [--out <file>]   Build workflow scripts from an entry, its parts, and the modules,
                                   text files and JSON files it imports.
  inspect <script> [--scenarios <file>] [--scenario <name>] [--call <index>]
                                   Run a workflow script against one scenario with no model call, and
                                   print the events of the simulation in order, or one call in full.
  locate <script> <line>[:<column>]
                                   Print the source line that a line of a built script comes from.
  simulate [<script>] [--scenarios <file>]
                                   Run a workflow script against each scenario of a scenarios file, with
                                   no model call, and print how each simulation ended.
  validate [<script>...]           Report each rule of the runtime's contract that a workflow script
                                   breaks.

Options:
  --help      Print this help.
  --version   Print the version.

Run dwfb <command> --help to see the options of a command.
`;

const BUILD_USAGE = `Usage: dwfb build [<entry>] [--out <file>] [options]

With no entry, builds every workflow of the config file. With an entry and no --out, builds each
workflow of the config file that has this entry. With an entry and --out, reads no config file.

Options:
  --out <file>      Write the built script to this file.
  --config <path>   Read this config file in place of ${CONFIG_FILES_TEXT}.
  --check           Write nothing, and report each built script that differs from its source.
  --no-banner       Leave out the banner line.
  --no-validate     Skip the check of the built script against the runtime's contract.
  --json            Print the result as one JSON object.
  --help            Print this help.
`;

const BUILD_OPTIONS = Object.freeze({
  out: { type: 'string' },
  config: { type: 'string' },
  check: { type: 'boolean' },
  'no-banner': { type: 'boolean' },
  'no-validate': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
});

const LOCATE_USAGE = `Usage: dwfb locate <script> <line>[:<column>] [options]

Prints the source file, line and column that a line of a built script comes from, then the source line.
The command builds the script in memory from the entry that its banner names, or with no banner from the
workflow of the config file whose out is the script.

Options:
  --runtime         Read the line and column as the runtime reports them, as in workflow.js:5:9.
  --entry <file>    Build the script from this entry.
  --config <path>   Read this config file in place of ${CONFIG_FILES_TEXT}.
  --json            Print the result as one JSON object.
  --help            Print this help.
`;

const LOCATE_OPTIONS = Object.freeze({
  runtime: { type: 'boolean' },
  entry: { type: 'string' },
  config: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
});

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

const VALIDATE_USAGE = `Usage: dwfb validate [<script>...] [options]

Reports each rule of the Workflow runtime's contract that a workflow script breaks, as measured on
Claude Code ${CONTRACT_RUNTIME_VERSION}. With no script, checks the out of every workflow of the config file
that does not set validate: false.

Options:
  --config <path>   Read this config file in place of ${CONFIG_FILES_TEXT}.
  --json            Print the result as one JSON object.
  --help            Print this help.
`;

const VALIDATE_OPTIONS = Object.freeze({
  config: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
});

process.exitCode = await runCommand(process.argv.slice(2));

/**
 * @param {string[]} args
 * @returns {Promise<number>} The exit code.
 */
async function runCommand(args) {
  const [command, ...commandArgs] = args;

  const isMainOption = command === '--version' || command === '--help';

  if (command === 'build') return runBuild(commandArgs);
  if (command === 'inspect') return runInspect(commandArgs);
  if (command === 'locate') return runLocate(commandArgs);
  if (command === 'simulate') return runSimulate(commandArgs);
  if (command === 'validate') return runValidate(commandArgs);
  if (isMainOption && commandArgs.length > 0) return printUsageError('dwfb', `The option ${command} takes no other argument, and ${JSON.stringify(commandArgs[0])} follows it.\n\n${MAIN_USAGE}`);
  if (command === '--version') return printResult(`${readVersion()}\n`);
  if (command === '--help') return printResult(MAIN_USAGE);

  const problem = command === undefined ? 'No command was given' : `Unknown command or option ${command}`;
  return printUsageError('dwfb', `${problem}.\n\n${MAIN_USAGE}`);
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function runBuild(args) {
  let parsed = null;
  let workflows = null;
  const builtWorkflows = [];

  try {
    parsed = parseArgs({ args, options: BUILD_OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    return printUsageError('dwfb build', `${error.message}\n\n${BUILD_USAGE}`);
  }

  const { values, positionals } = parsed;
  const [entry] = positionals;
  if (values.help) return printResult(BUILD_USAGE);
  if (positionals.length > 1 || entry === '') return printUsageError('dwfb build', `Name one entry file.\n\n${BUILD_USAGE}`);
  if (values.out === '') return printUsageError('dwfb build', `Name the built script with --out <file>.\n\n${BUILD_USAGE}`);
  if (values.config === '') return printUsageError('dwfb build', `Name the config file with --config <path>.\n\n${BUILD_USAGE}`);
  if (values.out !== undefined && entry === undefined) return printUsageError('dwfb build', `Name the entry file that --out builds.\n\n${BUILD_USAGE}`);
  if (values.out !== undefined && values.config !== undefined) return printUsageError('dwfb build', `Name --out or --config, not both.\n\n${BUILD_USAGE}`);

  const buildCommand = formatBuildCommand(entry, values);
  try {
    workflows = await findWorkflows(entry, values.out, values.config);
  } catch (error) {
    return printCommandFailure('dwfb build', error);
  }
  // Every workflow builds before any script is written, so a usage error in a later workflow writes nothing.
  for (const workflow of workflows) {
    const banner = values['no-banner'] ? false : workflow.banner;
    const validate = values['no-validate'] ? false : workflow.validate;
    try {
      builtWorkflows.push({ workflow, result: await build({ entry: workflow.entry, out: workflow.out, banner, check: values.check === true, write: false, validate }), out: null });
    } catch (error) {
      return printCommandFailure('dwfb build', error);
    }
  }
  try {
    await checkOutFiles(builtWorkflows);
  } catch (error) {
    return printCommandFailure('dwfb build', error);
  }
  for (const builtWorkflow of builtWorkflows) {
    try {
      if (builtWorkflow.result.status === 'built') {
        await writeScript(resolve(builtWorkflow.workflow.out), builtWorkflow.result.script);
        builtWorkflow.result = { ...builtWorkflow.result, status: 'written' };
      }
      // The out path takes the base of the source paths, so that one output names each file one way.
      builtWorkflow.out = await formatRealDisplayPath(builtWorkflow.workflow.out);
    } catch (error) {
      return printCommandFailure('dwfb build', error, await formatWrittenNote(builtWorkflows));
    }
    if (!values.json) process.stdout.write(formatBuildText(builtWorkflow.out, builtWorkflow.result, buildCommand));
  }

  const isSuccess = builtWorkflows.every(({ result }) => result.ok);
  const exitCode = isSuccess ? EXIT_SUCCESS : EXIT_FINDINGS;
  if (values.json) return printResult(`${JSON.stringify(formatBuildJson(builtWorkflows, isSuccess), null, 2)}\n`, exitCode);
  return exitCode;
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function runLocate(args) {
  let parsed = null;
  let result = null;

  try {
    parsed = parseArgs({ args, options: LOCATE_OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    return printUsageError('dwfb locate', `${error.message}\n\n${LOCATE_USAGE}`);
  }

  const { values, positionals } = parsed;
  const [script, position] = positionals;
  const positionMatch = SCRIPT_POSITION_PATTERN.exec(position ?? '');
  if (values.help) return printResult(LOCATE_USAGE);
  if (positionals.length !== 2 || script === '' || position === '') return printUsageError('dwfb locate', `Name one built script and one line.\n\n${LOCATE_USAGE}`);
  if (positionMatch === null) return printUsageError('dwfb locate', `The line ${position} is not a whole number, or a line and a column such as 12:5.\n\n${LOCATE_USAGE}`);
  if (values.entry === '') return printUsageError('dwfb locate', `Name the entry file with --entry <file>.\n\n${LOCATE_USAGE}`);
  if (values.config === '') return printUsageError('dwfb locate', `Name the config file with --config <path>.\n\n${LOCATE_USAGE}`);
  const { line, column } = /** @type {{ line: string, column?: string }} */ (positionMatch.groups);
  // Number() rounds a larger digit string, so locate() would name a number the user did not type.
  if (!Number.isSafeInteger(Number(line))) return printUsageError('dwfb locate', `The line ${line} is larger than ${Number.MAX_SAFE_INTEGER}.\n\n${LOCATE_USAGE}`);
  if (column !== undefined && !Number.isSafeInteger(Number(column))) return printUsageError('dwfb locate', `The column ${column} is larger than ${Number.MAX_SAFE_INTEGER}.\n\n${LOCATE_USAGE}`);

  try {
    result = await locate({
      script,
      line: Number(line),
      ...(column === undefined ? {} : { column: Number(column) }),
      runtime: values.runtime === true,
      entry: values.entry,
      config: values.config,
    });
  } catch (error) {
    return printCommandFailure('dwfb locate', error);
  }

  const exitCode = result.ok ? EXIT_SUCCESS : EXIT_FINDINGS;
  if (values.json) return printResult(`${JSON.stringify(result, null, 2)}\n`, exitCode);
  return printResult(formatLocateText(result), exitCode);
}

/**
 * @param {import('../src/locate.js').LocateResult} result
 * @returns {string} The lines a person reads.
 */
function formatLocateText(result) {
  if (!result.ok) return result.findings.map((finding) => `${formatFinding(finding)}\n`).join('');
  if (result.generated) return `${formatLineSource({ file: result.file, sourceLine: null })} It has no source line.\n`;
  return `${result.file}:${result.line}:${result.column}\n${result.text}\n`;
}

/**
 * @typedef {object} Simulation One scenario's simulation, as `dwfb simulate` reports it.
 * @property {string} script The script, as the trace names it.
 * @property {string} scenario The scenario's name.
 * @property {'returned' | 'threw'} expect
 * @property {boolean} passed True when the trace's end kind is `expect`.
 * @property {import('../src/simulate.js').Trace} trace
 */

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function runSimulate(args) {
  let parsed = null;
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
  if (positionals.length > 1 || script === '') return printUsageError('dwfb simulate', `Name one workflow script.\n\n${SIMULATE_USAGE}`);
  if (values.scenarios === '') return printUsageError('dwfb simulate', `Name the scenarios file with --scenarios <file>.\n\n${SIMULATE_USAGE}`);
  if (values.scenario === '') return printUsageError('dwfb simulate', `Name the scenario with --scenario <name>.\n\n${SIMULATE_USAGE}`);
  if (values.config === '') return printUsageError('dwfb simulate', `Name the config file with --config <path>.\n\n${SIMULATE_USAGE}`);
  if (script === undefined && values.scenarios !== undefined) return printUsageError('dwfb simulate', `Name the script that --scenarios simulates.\n\n${SIMULATE_USAGE}`);
  if (script === undefined && values.scenario !== undefined) return printUsageError('dwfb simulate', `Name the script that --scenario simulates.\n\n${SIMULATE_USAGE}`);
  if (values.scenarios !== undefined && values.config !== undefined) return printUsageError('dwfb simulate', `${SCENARIOS_CONFIG_CONFLICT}.\n\n${SIMULATE_USAGE}`);

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

/**
 * @typedef {object} SimulationTarget One script and the scenarios file it runs against.
 * @property {string} script
 * @property {string} scenariosFile
 * @property {string | null} entry The entry of the config workflow that names the scenarios file, or null for
 *   a scenarios file that `--scenarios` names.
 */

/**
 * Finds the script and scenarios file of each workflow that `dwfb simulate` with no script runs: the out of
 * each workflow of the config file that has scenarios, with its scenarios file, in the order the config file
 * lists them, relative to the working directory.
 * @param {string | undefined} configPath
 * @returns {Promise<SimulationTarget[]>}
 */
async function findConfigTargets(configPath) {
  const commandConfig = await loadCommandConfig(configPath);
  const targets = [];

  if (commandConfig === null) throw new UsageError(`No config file ${CONFIG_FILES_TEXT} exists here, so name a script and --scenarios <file>, or name a config file with --config <path>`);
  for (const workflow of commandConfig.config.workflows) {
    if (workflow.scenarios === null) continue;
    await checkBuiltOut(workflow, configPath);
    targets.push({ script: formatDisplayPath(workflow.out), scenariosFile: formatDisplayPath(workflow.scenarios), entry: formatDisplayPath(workflow.entry) });
  }
  if (targets.length === 0) throw new UsageError(`The config file ${commandConfig.file} has no workflow with scenarios, so give a workflow scenarios, or name a script and --scenarios <file>`);

  return targets;
}

/**
 * Finds the scenarios file of a script that `dwfb simulate` or `dwfb inspect` names: the file `--scenarios`
 * names, else the scenarios of the first workflow of the config file whose out is the script, as locate()
 * takes the first.
 * @param {string} script
 * @param {string | undefined} scenariosFile The path `--scenarios` names.
 * @param {string | undefined} configPath The path `--config` names.
 * @returns {Promise<SimulationTarget>}
 */
async function findScriptTarget(script, scenariosFile, configPath) {
  let commandConfig = null;
  let scriptWorkflow;

  if (scenariosFile !== undefined) return { script, scenariosFile, entry: null };
  commandConfig = await loadCommandConfig(configPath);
  if (commandConfig === null) throw new UsageError(`No config file ${CONFIG_FILES_TEXT} exists here, ${SCENARIOS_FILE_RECOVERY}`);
  [scriptWorkflow] = await findConfigWorkflows(commandConfig.config.workflows, 'out', script);
  if (scriptWorkflow === undefined) throw new UsageError(`The config file ${commandConfig.file} has no workflow whose out is ${script}, ${SCENARIOS_FILE_RECOVERY}`);
  if (scriptWorkflow.scenarios === null) throw new UsageError(`The workflow whose entry is ${formatDisplayPath(scriptWorkflow.entry)} has no scenarios, ${SCENARIOS_FILE_RECOVERY}`);
  await checkBuiltOut(scriptWorkflow, configPath);

  return { script, scenariosFile: formatDisplayPath(scriptWorkflow.scenarios), entry: formatDisplayPath(scriptWorkflow.entry) };
}

/**
 * @param {SimulationTarget} target
 * @returns {Promise<import('../src/check-scenarios.js').FileScenario[]>}
 */
async function loadTargetScenarios({ scenariosFile, entry }) {
  try {
    return await loadScenarios(scenariosFile);
  } catch (error) {
    if (!(error instanceof UsageError) || entry === null) throw error;
    // loadScenarios() names the scenarios file alone, which names no workflow of the config file.
    const failure = new UsageError(`The scenarios of the workflow whose entry is ${entry} cannot load. ${error.message}`);
    failure.cause = error;
    throw failure;
  }
}

/**
 * @param {import('../src/check-scenarios.js').FileScenario[]} fileScenarios
 * @param {string | undefined} name The name `--scenario` gives.
 * @param {string} scenariosFile
 * @returns {import('../src/check-scenarios.js').FileScenario[]} Every scenario when name is undefined, else the
 *   one scenario of that name.
 */
function selectScenarios(fileScenarios, name, scenariosFile) {
  const namedScenarios = fileScenarios.filter((fileScenario) => fileScenario.name === name);

  if (name === undefined) return fileScenarios;
  if (namedScenarios.length === 0) throw new UsageError(`The scenarios file ${scenariosFile} holds no scenario named "${formatHiddenCharacters(name)}"`);

  return namedScenarios;
}

/**
 * @param {string} script
 * @param {import('../src/check-scenarios.js').FileScenario} fileScenario
 * @param {string} scenariosFile
 * @returns {Promise<Simulation>}
 */
async function simulateScenario(script, fileScenario, scenariosFile) {
  const { name, expect, scenario } = fileScenario;
  let trace = null;

  try {
    trace = await simulate({ script, scenario });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    // simulate() names neither the scenario nor its file, such as for a respond function that throws.
    const failure = new UsageError(`The simulation of ${script} with the scenario "${formatHiddenCharacters(name)}" of ${scenariosFile} cannot run. ${error.message}`);
    failure.cause = error;
    throw failure;
  }

  return { script: trace.script, scenario: name, expect, passed: trace.end.kind === expect, trace };
}

/**
 * @param {Simulation[]} simulations In the order run.
 * @returns {string} One line per simulation, after the findings of each refused script the first time it is
 *   refused, then the counts of passed and failed scenarios.
 */
function formatSimulateText(simulations) {
  const refusedScripts = new Set();
  const passedCount = simulations.filter((simulation) => simulation.passed).length;
  const lines = [];

  for (const simulation of simulations) {
    const { end } = simulation.trace;
    if (end.kind === 'refused' && !refusedScripts.has(simulation.script)) {
      refusedScripts.add(simulation.script);
      lines.push(...end.findings.map(formatFinding));
    }
    lines.push(formatSimulationLine(simulation));
  }
  lines.push(`${passedCount} passed, ${simulations.length - passedCount} failed.`);

  return lines.map((line) => `${line}\n`).join('');
}

/**
 * @param {Simulation} simulation
 * @returns {string} Such as `FAILED review.js no reviewer: stopped at call 1 (label "review"): <message>, 2 calls.`
 */
function formatSimulationLine(simulation) {
  return `${simulation.passed ? '' : 'FAILED '}${formatTraceLine(simulation)}`;
}

/**
 * @param {Simulation} simulation
 * @returns {string} Such as `review.js passes: returned, 1 call.`
 */
function formatTraceLine({ script, scenario, trace }) {
  return `${script} ${formatHiddenCharacters(scenario)}: ${formatSimulationEnd(trace)}, ${formatCount(trace.calls.length, 'call')}.`;
}

/**
 * @param {number} count
 * @param {string} noun The singular, which takes an s for any other count than 1.
 * @returns {string} Such as `1 call` or `0 calls`.
 */
function formatCount(count, noun) {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

/**
 * @param {Simulation[]} simulations In the order run.
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape, which is part of the public interface.
 */
function formatSimulateJson(simulations, isSuccess) {
  return {
    ok: isSuccess,
    runtime: CONTRACT_RUNTIME_VERSION,
    simulations: simulations.map(({ script, scenario, expect, passed, trace }) => ({ script, scenario, expect, passed, trace })),
  };
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function runInspect(args) {
  let parsed = null;
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
  if (positionals.length !== 1 || script === '') return printUsageError('dwfb inspect', `Name one workflow script.\n\n${INSPECT_USAGE}`);
  if (values.scenarios === '') return printUsageError('dwfb inspect', `Name the scenarios file with --scenarios <file>.\n\n${INSPECT_USAGE}`);
  if (values.scenario === '') return printUsageError('dwfb inspect', `Name the scenario with --scenario <name>.\n\n${INSPECT_USAGE}`);
  if (values.call === '') return printUsageError('dwfb inspect', `Name the call with --call <index>.\n\n${INSPECT_USAGE}`);
  if (values.config === '') return printUsageError('dwfb inspect', `Name the config file with --config <path>.\n\n${INSPECT_USAGE}`);
  if (values.scenarios !== undefined && values.config !== undefined) return printUsageError('dwfb inspect', `${SCENARIOS_CONFIG_CONFLICT}.\n\n${INSPECT_USAGE}`);
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
 * @param {SimulationTarget} target
 * @param {string | undefined} name The name `--scenario` gives.
 * @returns {Promise<Simulation>} The simulation of the one scenario that `dwfb inspect` runs.
 */
async function simulateTarget(target, name) {
  const fileScenario = selectInspectScenario(await loadTargetScenarios(target), name, target.scenariosFile);

  return simulateScenario(target.script, fileScenario, target.scenariosFile);
}

/**
 * @param {import('../src/check-scenarios.js').FileScenario[]} fileScenarios
 * @param {string | undefined} name The name `--scenario` gives.
 * @param {string} scenariosFile
 * @returns {import('../src/check-scenarios.js').FileScenario} The scenario of that name, or with no name the one
 *   scenario of the file.
 */
function selectInspectScenario(fileScenarios, name, scenariosFile) {
  const names = fileScenarios.map((fileScenario) => `"${formatHiddenCharacters(fileScenario.name)}"`);

  if (name !== undefined) return selectScenarios(fileScenarios, name, scenariosFile)[0];
  if (fileScenarios.length === 1) return fileScenarios[0];

  throw new UsageError(`The scenarios file ${scenariosFile} holds ${fileScenarios.length} scenarios, so name one with --scenario <name>: ${names.join(', ')}`);
}

/**
 * @param {Simulation} simulation
 * @param {import('../src/create-inspection.js').Inspection} inspection
 * @returns {string} The lines a person reads: for a refused script its findings and the line of how the
 *   simulation ended, else one call in full, else that line and then one line per event. That line is the
 *   line of `dwfb simulate` with no `FAILED ` mark.
 */
function formatInspectionText(simulation, inspection) {
  const { end } = simulation.trace;

  if (end.kind === 'refused') return [...end.findings.map(formatFinding), formatTraceLine(simulation)].map((line) => `${line}\n`).join('');
  if (inspection.call !== undefined) return formatInspectionCallText(simulation, inspection.call, end);

  return [formatTraceLine(simulation), ...(inspection.events ?? []).map(formatEventLine)].map((line) => `${line}\n`).join('');
}

/**
 * @param {import('../src/create-inspection.js').InspectionEvent} event
 * @returns {string} One line, since each title, text and label goes through formatHiddenCharacters.
 */
function formatEventLine(event) {
  if (event.kind === 'phase') return `phase "${formatHiddenCharacters(event.title)}"`;
  if (event.kind === 'log') return `log ${formatHiddenCharacters(event.text)}`;
  return formatCallEventLine(event);
}

/**
 * @param {Extract<import('../src/create-inspection.js').InspectionEvent, { kind: 'call' }>} event
 * @returns {string} Such as `call 0 (label "review"): prompt of 32 characters, returned an object.`
 */
function formatCallEventLine(event) {
  const parts = [];

  if (event.phase !== null) parts.push(`phase "${formatHiddenCharacters(event.phase)}"`);
  if (event.group !== null) parts.push(formatGroupPart(event.group));
  parts.push(`prompt of ${formatCount(event.promptLength, 'character')}`, formatReturnedPart(event));

  return `${formatCallName(event)}: ${parts.join(', ')}.`;
}

/**
 * @param {import('../src/create-inspection.js').InspectionGroup} group
 * @returns {string} Such as `parallel 0 item 2` or `pipeline 1 item 0 stage 1`.
 */
function formatGroupPart({ index, kind, item, stage }) {
  return kind === 'parallel' ? `parallel ${index} item ${item}` : `pipeline ${index} item ${item} stage ${stage}`;
}

/**
 * @param {{ returnedType: 'string' | 'object' | 'null' | 'none', returnedLength: number | null }} event
 * @returns {string}
 */
function formatReturnedPart({ returnedType, returnedLength }) {
  if (returnedType === 'string') return `returned a string of ${formatCount(/** @type {number} */ (returnedLength), 'character')}`;
  if (returnedType === 'object') return 'returned an object';
  if (returnedType === 'null') return 'returned null';
  return 'no return';
}

/**
 * @param {Simulation} simulation
 * @param {import('../src/create-inspection.js').InspectionCall} call
 * @param {import('../src/simulate.js').TraceEnd} end
 * @returns {string}
 */
function formatInspectionCallText({ script, scenario }, call, end) {
  const { phase, group, opts, prompt } = call;
  const phaseLine = phase === null ? 'phase: none' : `phase: "${formatHiddenCharacters(phase)}"`;
  // A trace gives null opts both for no options and for options JSON cannot hold, such as a BigInt.
  const optionsText = opts === null ? 'options: none, or options that JSON cannot hold\n' : `options:\n${JSON.stringify(opts, null, 2)}\n`;

  return [
    `${formatCallName(call)} of ${script} ${formatHiddenCharacters(scenario)}\n`,
    `${phaseLine}\n`,
    `${formatGroupLine(group)}\n`,
    optionsText,
    `prompt of ${formatCount(prompt.length, 'character')}:\n${formatWithLineEnd(prompt)}`,
    formatReturnedText(call, end),
  ].join('');
}

/**
 * @param {import('../src/create-inspection.js').InspectionGroup | null} group
 * @returns {string}
 */
function formatGroupLine(group) {
  if (group === null) return 'group: none';
  if (group.kind === 'parallel') return `group: parallel ${group.index}, item ${group.item} of ${group.items}`;
  return `group: pipeline ${group.index}, item ${group.item} of ${group.items}, stage ${group.stage} of ${group.stages}`;
}

/**
 * @param {import('../src/create-inspection.js').InspectionCall} call
 * @param {import('../src/simulate.js').TraceEnd} end
 * @returns {string}
 */
function formatReturnedText(call, end) {
  const isStoppedCall = end.kind === 'stopped' && 'call' in end && end.call === call.index;

  if (isStoppedCall) return `stopped: ${formatHiddenCharacters(end.message)}\n`;
  // Any other call with no returned key was made after the script settled, where a stop ends nothing.
  if (!Object.hasOwn(call, 'returned')) return isPastCallLimit(call.index) ? `${LATE_CAP_LINE}\n` : `${LATE_CALL_LINE}\n`;
  if (call.returned === null) return 'returned: null, an agent that died\n';
  if (typeof call.returned === 'string') return `returned a string of ${formatCount(call.returned.length, 'character')}:\n${formatWithLineEnd(call.returned)}`;
  return `returned:\n${JSON.stringify(call.returned, null, 2)}\n`;
}

/**
 * @param {string} text
 * @returns {string} The text with a line end added when it ends with none, so the next line starts on its own line.
 */
function formatWithLineEnd(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function runValidate(args) {
  let parsed = null;
  let selection = null;
  const results = [];

  try {
    parsed = parseArgs({ args, options: VALIDATE_OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    return printUsageError('dwfb validate', `${error.message}\n\n${VALIDATE_USAGE}`);
  }

  const { values, positionals } = parsed;
  if (values.help) return printResult(VALIDATE_USAGE);
  if (positionals.includes('')) return printUsageError('dwfb validate', `Name each script by its path.\n\n${VALIDATE_USAGE}`);
  if (values.config === '') return printUsageError('dwfb validate', `Name the config file with --config <path>.\n\n${VALIDATE_USAGE}`);
  if (positionals.length > 0 && values.config !== undefined) {
    return printUsageError('dwfb validate', `Name scripts or --config, not both, since a named script needs no config file.\n\n${VALIDATE_USAGE}`);
  }

  // Every script is checked before any result prints, so a usage error in a later script prints no result.
  try {
    selection = positionals.length > 0 ? { scripts: positionals, skipped: [] } : await findConfigScripts(values.config);
    for (const script of selection.scripts) results.push(await validate({ script }));
  } catch (error) {
    return printCommandFailure('dwfb validate', error);
  }

  const { skipped } = selection;
  const isSuccess = results.every((result) => result.ok);
  const exitCode = isSuccess ? EXIT_SUCCESS : EXIT_FINDINGS;
  if (values.json) return printResult(`${JSON.stringify(formatValidateJson(results, skipped, isSuccess), null, 2)}\n`, exitCode);
  return printResult(`${results.map(formatValidateText).join('')}${skipped.map(formatSkippedText).join('')}`, exitCode);
}

/**
 * @param {import('../src/validate.js').ValidateResult} result
 * @returns {string} The lines a person reads for one script.
 */
function formatValidateText(result) {
  if (result.ok) return `${result.script} breaks no rule of the contract measured on Claude Code ${result.runtime}.\n`;
  return result.findings.map((finding) => `${formatFinding(finding)}\n`).join('');
}

/**
 * @param {string} out The out of a skipped workflow, as findConfigScripts gives it.
 * @returns {string} The line a person reads for one skipped workflow.
 */
function formatSkippedText(out) {
  return `Skipped ${out}, since its workflow sets validate: false.\n`;
}

/**
 * @param {import('../src/validate.js').ValidateResult[]} results In the order checked.
 * @param {string[]} skipped The out of each skipped workflow, as findConfigScripts gives it.
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape, which is part of the public interface.
 */
function formatValidateJson(results, skipped, isSuccess) {
  return {
    ok: isSuccess,
    runtime: CONTRACT_RUNTIME_VERSION,
    scripts: results.map(({ script, findings }) => ({ script, findings })),
    skipped,
  };
}

/**
 * Finds the scripts one `dwfb validate` with no script checks: the out of each workflow of the config file,
 * in the order the config file lists them, relative to the working directory. A workflow with
 * `validate: false` is skipped, so its out needs no file.
 * @param {string | undefined} configPath
 * @returns {Promise<{ scripts: string[], skipped: string[] }>} The out of each checked and each skipped workflow.
 *   A skipped out is relative to the working directory's real path, as validate() names a checked script.
 */
async function findConfigScripts(configPath) {
  const commandConfig = await loadCommandConfig(configPath);
  const scripts = [];
  const skipped = [];

  if (commandConfig === null) throw new UsageError(`No config file ${CONFIG_FILES_TEXT} exists here, so name a script, or name a config file with --config <path>`);
  for (const workflow of commandConfig.config.workflows) {
    if (!workflow.validate) {
      skipped.push(await formatRealDisplayPath(workflow.out));
      continue;
    }
    await checkBuiltOut(workflow, configPath);
    scripts.push(formatDisplayPath(workflow.out));
  }

  return { scripts, skipped };
}

/**
 * Throws a UsageError that names the command that builds the out of a config workflow when no file exists
 * there, since a check of the missing script would name no workflow.
 * @param {{ entry: string, out: string }} workflow
 * @param {string | undefined} configPath The path `--config` names, which the build command names too.
 */
async function checkBuiltOut(workflow, configPath) {
  const entry = formatDisplayPath(workflow.entry);
  const out = formatDisplayPath(workflow.out);

  if (await isMissingFile(out)) {
    throw new UsageError(`The out file ${out} of the workflow whose entry is ${entry} does not exist, so run ${formatBuildCommand(entry, { config: configPath })}`);
  }
}

/**
 * @param {string} path
 * @returns {Promise<boolean>} True when no file or folder exists at the path.
 */
async function isMissingFile(path) {
  try {
    await stat(resolve(path));
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) return true;
    throw error;
  }
  return false;
}

/**
 * Finds the workflows one `dwfb build` builds. A config file's workflows get paths relative to the working
 * directory, and the `--out` workflow keeps the paths as the user typed them.
 * @param {string | undefined} entry
 * @param {string | undefined} out
 * @param {string | undefined} configPath
 * @returns {Promise<{ entry: string, out: string, banner: boolean, validate: boolean, scenarios?: string | null }[]>} A
 *   config workflow keeps its absolute scenarios path.
 */
async function findWorkflows(entry, out, configPath) {
  if (out !== undefined) return [{ entry, out, banner: true, validate: true }];
  const commandConfig = await loadCommandConfig(configPath);
  if (commandConfig === null) {
    const missingWhat = entry === undefined ? 'an entry file' : 'the built script with --out <file>';
    throw new UsageError(`No config file ${CONFIG_FILES_TEXT} exists here, so name ${missingWhat}`);
  }

  const configWorkflows = commandConfig.config.workflows.map((workflow) => ({ ...workflow, entry: formatDisplayPath(workflow.entry), out: formatDisplayPath(workflow.out) }));
  if (entry === undefined) return configWorkflows;

  const entryWorkflows = await findConfigWorkflows(configWorkflows, 'entry', entry);
  if (entryWorkflows.length === 0) throw new UsageError(`The config file ${commandConfig.file} has no workflow whose entry is ${entry}`);

  return entryWorkflows;
}

/**
 * build() refuses an `out` that is a source of its own workflow. This extends the refusal to the sources of
 * every workflow the command builds, since the command writes each script after every workflow builds. It
 * also refuses two workflows whose `out` paths name one file through a link, and an `out` that names the
 * scenarios file of a workflow the command builds through a link, which checkConfig cannot see.
 * @param {{ workflow: { entry: string, out: string, scenarios?: string | null }, result: import('../src/build.js').BuildResult }[]} builtWorkflows
 */
async function checkOutFiles(builtWorkflows) {
  // build() gives each source relative to the working directory's real path.
  const workFolder = await realpath(process.cwd());
  const sourceWorkflows = new Map();
  const scenariosFiles = [];
  const outFiles = [];

  for (const { workflow, result } of builtWorkflows) {
    for (const source of result.sources) {
      const sourceFile = resolve(workFolder, source);
      if (!sourceWorkflows.has(sourceFile)) sourceWorkflows.set(sourceFile, workflow);
    }
    // A workflow that --out names has no scenarios field.
    if (typeof workflow.scenarios !== 'string') continue;
    scenariosFiles.push({ file: await findRealPath(workflow.scenarios), workflow });
  }
  for (const { workflow } of builtWorkflows) {
    const outFile = await findRealPath(workflow.out);
    const sourceWorkflow = sourceWorkflows.get(outFile);
    // checkConfig refuses two out paths that differ only in letter case on every platform, and so does this check.
    const scenariosFile = findSameFile(scenariosFiles, outFile);
    const sameOutFile = findSameFile(outFiles, outFile);
    const outLabel = `The out file ${formatDisplayPath(workflow.out)} of the workflow whose entry is ${formatDisplayPath(workflow.entry)}`;
    if (sourceWorkflow !== undefined) throw new UsageError(`${outLabel} is a source of the workflow whose entry is ${formatDisplayPath(sourceWorkflow.entry)}`);
    if (scenariosFile !== undefined) {
      const scenariosWorkflow = scenariosFile.workflow;
      throw new UsageError(`${outLabel} names the scenarios file ${formatDisplayPath(scenariosWorkflow.scenarios)} of the workflow whose entry is ${formatDisplayPath(scenariosWorkflow.entry)}${formatCaseNote(scenariosFile.file, outFile)}`);
    }
    if (sameOutFile !== undefined) {
      const outWorkflow = sameOutFile.workflow;
      throw new UsageError(`${outLabel} names the same file as the out file ${formatDisplayPath(outWorkflow.out)} of the workflow whose entry is ${formatDisplayPath(outWorkflow.entry)}${formatCaseNote(sameOutFile.file, outFile)}`);
    }
    outFiles.push({ file: outFile, workflow });
  }
}

/**
 * @template {{ file: string }} T
 * @param {T[]} realFiles Each with a real path, in the order the command builds the workflows.
 * @param {string} file A real path.
 * @returns {T | undefined} The first entry whose file is `file`, else the first whose file differs from it only in letter case.
 */
function findSameFile(realFiles, file) {
  const fileKey = file.toLowerCase();

  return realFiles.find((realFile) => realFile.file === file) ?? realFiles.find((realFile) => realFile.file.toLowerCase() === fileKey);
}

/**
 * @param {string} file A real path.
 * @param {string} otherFile A real path that names `file` in the same or another letter case.
 * @returns {string} The end of a message for two paths that name one file only where file names ignore letter case.
 */
function formatCaseNote(file, otherFile) {
  return file === otherFile ? '' : ' where file names ignore letter case';
}

/**
 * @param {string} out The built script, as formatRealDisplayPath gives it.
 * @param {import('../src/build.js').BuildResult} result
 * @param {string} buildCommand The command that rewrites a script that differs or is missing.
 * @returns {string} The lines a person reads for one workflow.
 */
function formatBuildText(out, result, buildCommand) {
  if (result.status === 'failed') return result.findings.map((finding) => `${formatFinding(finding)}\n`).join('');
  if (result.status === 'fresh') return `${out} matches its source.\n`;
  if (result.status === 'missing') return `${out} does not exist. Run ${buildCommand}.\n`;
  if (result.status === 'stale') return `${out}:${result.firstDifference.line} differs from the script the build gives. ${formatLineSource(result.firstDifference)} Run ${buildCommand}.\n`;

  const sourceCount = result.sources.length === 1 ? '1 source file' : `${result.sources.length} source files`;
  return `Built ${out} from ${sourceCount}, ${Buffer.byteLength(result.script, 'utf8')} bytes.\n`;
}

/**
 * @param {{ file: string | null, sourceLine: number | null }} lineSource The source of one built line, such as
 *   a FirstDifference.
 * @returns {string}
 */
function formatLineSource({ file, sourceLine }) {
  if (sourceLine !== null) return `The line comes from ${file}:${sourceLine}.`;
  if (file !== null) return `The build adds the line for ${file}.`;
  return 'The build adds the line.';
}

/**
 * @param {{ result: import('../src/build.js').BuildResult, out: string }[]} builtWorkflows Each `out` as
 *   formatRealDisplayPath gives it.
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape, which is part of the public interface. Every path takes the form
 *   BuildResult gives it, except `out`, which takes the form formatRealDisplayPath gives it.
 */
function formatBuildJson(builtWorkflows, isSuccess) {
  return {
    ok: isSuccess,
    workflows: builtWorkflows.map(({ result, out }) => ({
      // A build reads the entry first, so its first source names the entry against the base of the other paths.
      entry: result.sources[0],
      out,
      status: result.status,
      bytes: result.script === null ? null : Buffer.byteLength(result.script, 'utf8'),
      sources: result.sources,
      findings: result.findings,
      ...(result.firstDifference === undefined ? {} : { firstDifference: result.firstDifference }),
    })),
  };
}

/**
 * @param {string} label The command, such as `dwfb build`.
 * @param {unknown} error
 * @param {string} [note] A sentence that follows the failure line's own, with its leading space.
 * @returns {Promise<number>}
 */
async function printCommandFailure(label, error, note = '') {
  if (error instanceof UsageError) return printUsageError(label, `${error.message}.${note}\n`);
  if (isFileSystemError(error)) {
    process.stderr.write(`${label}: Could not read or write ${await formatFailedPath(error.path)} (${error.syscall} ${error.code}).${note}\n`);
    return EXIT_FAILURE;
  }
  process.stderr.write(`${label}: internal failure.${note}\n${error.stack ?? error}\n`);
  return EXIT_FAILURE;
}

/**
 * @param {{ workflow: { out: string }, result: { status: string } }[]} builtWorkflows
 * @returns {Promise<string>} The sentence that names each script written before a failure, in write order, or
 *   '' when none was written.
 */
async function formatWrittenNote(builtWorkflows) {
  const writtenPaths = [];
  for (const { workflow, result } of builtWorkflows) {
    if (result.status === 'written') writtenPaths.push(await formatFailedPath(workflow.out));
  }
  return writtenPaths.length === 0 ? '' : ` Wrote ${writtenPaths.join(', ')} before the failure.`;
}

/**
 * @param {string} path The path a file system call failed on.
 * @returns {Promise<string>} The path as formatRealDisplayPath gives it, or as formatDisplayPath gives it when
 *   the folders above it cannot be read, since that error would hide the failure the message reports.
 */
async function formatFailedPath(path) {
  try {
    return await formatRealDisplayPath(path);
  } catch {
    return formatDisplayPath(path);
  }
}

/**
 * @param {unknown} error
 * @returns {error is NodeJS.ErrnoException & { path: string, syscall: string }} True for a
 *   failed file system call, which names the path it failed on.
 */
function isFileSystemError(error) {
  return error instanceof Error && typeof error.code === 'string' && typeof error.path === 'string' && typeof error.syscall === 'string';
}

/**
 * @returns {string}
 */
function readVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

/**
 * @param {string} text
 * @param {number} [exitCode]
 * @returns {number}
 */
function printResult(text, exitCode = EXIT_SUCCESS) {
  process.stdout.write(text);
  return exitCode;
}

/**
 * @param {string} label
 * @param {string} text
 * @returns {number}
 */
function printUsageError(label, text) {
  process.stderr.write(`${label}: ${text}`);
  return EXIT_FAILURE;
}
