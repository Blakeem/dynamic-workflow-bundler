#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findBanner } from '../src/banner.js';
import { build } from '../src/build.js';
import { formatBuildCommand } from '../src/build-command.js';
import { checkOutPath } from '../src/check-out-path.js';
import { AGENT_CALL_LIMIT, CONTRACT_RUNTIME_VERSION, isPastCallLimit } from '../src/contract.js';
import { createInspection } from '../src/create-inspection.js';
import { formatDisplayPath, isFolderPath } from '../src/display-path.js';
import { findConfigWorkflows } from '../src/find-config-workflows.js';
import { formatCallName } from '../src/find-scripted-return.js';
import { formatFinding } from '../src/format-finding.js';
import { formatFlowMap } from '../src/format-flow-map.js';
import { formatHiddenCharacters } from '../src/format-hidden-characters.js';
import { formatSimulationEnd } from '../src/format-simulation-end.js';
import { CONFIG_FILES_TEXT, loadCommandConfig } from '../src/load-config.js';
import { loadScenarios } from '../src/load-scenarios.js';
import { loadSources, MISSING_FILE_CODES } from '../src/load-sources.js';
import { locate } from '../src/locate.js';
import { map } from '../src/map.js';
import { PARSE_OPTIONS, parseSource } from '../src/parse-source.js';
import { readMetaValue } from '../src/read-meta-value.js';
import { readScript } from '../src/read-script.js';
import { findRealPath, formatRealDisplayPath } from '../src/real-path.js';
import { simulateFileScenario } from '../src/simulate-file-scenario.js';
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
  map [<script>] [--scenarios <file>] [--out <file>]
                                   Run a workflow script against each scenario of a scenarios file, with
                                   no model call, and write the flow map of every path they reach.
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

const MAP_USAGE = `Usage: dwfb map [<script>] [--scenarios <file>] [--out <file>] [options]

Runs a workflow script against each scenario of a scenarios file with no model call, as the runtime of
Claude Code ${CONTRACT_RUNTIME_VERSION} runs it, and writes the flow map of every path the scenarios reach: a
Markdown document with one Mermaid diagram. With a script and no --scenarios, reads the scenarios file of the
workflow of the config file whose out is the script. The flow map goes to --out, else to the map of that
workflow, else to stdout. With no script, writes the map of each workflow of the config file that has map.

A scenario is mapped only when its script follows these rules. Each agent() call has a label. Each label
starts with a role. A role is the text before the first \${...} of a label string in the script. The script
returns an object whose status is a string of 1 or more characters, or its scenario has an endState. An error
that the script throws on purpose is created by the throw new <Name>(...) statement that throws it. After the
top level of the script or a lane starts a parallel() or pipeline() group, it makes no agent() call of its own
before the last call made in that group or in a group started inside it. A lane is one thunk of a parallel() or
one item of a pipeline().

Options:
  --scenarios <file>   Read the scenarios of the script from this file.
  --out <file>         Write the flow map to this file.
  --check              Write nothing, and report each flow map file that differs from the flow map the
                       script and its scenarios give.
  --config <path>      Read this config file in place of ${CONFIG_FILES_TEXT}.
  --json               Print the result as one JSON object, and write no file. With --check, the check
                       key of each mapped script is fresh, stale or missing.
  --help               Print this help.
`;

const MAP_OPTIONS = Object.freeze({
  scenarios: { type: 'string' },
  out: { type: 'string' },
  check: { type: 'boolean' },
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
  if (command === 'map') return runMap(commandArgs);
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
  let configFile = null;
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
    ({ configFile, workflows } = await findWorkflows(entry, values.out, values.config));
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
    await checkOutFiles(builtWorkflows, configFile);
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
      const writtenOuts = builtWorkflows.filter(({ result }) => result.status === 'written').map(({ workflow }) => workflow.out);
      return printCommandFailure('dwfb build', error, await formatWrittenNote(writtenOuts));
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
 * @property {string | null} map The map of that config workflow, or null for a workflow with no map and for a
 *   scenarios file that `--scenarios` names.
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
    targets.push(formatConfigTarget(workflow));
  }
  if (targets.length === 0) throw new UsageError(`The config file ${commandConfig.file} has no workflow with scenarios, so give a workflow scenarios, or name a script and --scenarios <file>`);

  return targets;
}

/**
 * @param {import('../src/check-config.js').ConfigWorkflow} workflow A workflow with scenarios.
 * @returns {SimulationTarget} With each path relative to the working directory.
 */
function formatConfigTarget(workflow) {
  return {
    script: formatDisplayPath(workflow.out),
    scenariosFile: formatDisplayPath(/** @type {string} */ (workflow.scenarios)),
    entry: formatDisplayPath(workflow.entry),
    map: workflow.map === null ? null : formatDisplayPath(workflow.map),
  };
}

/**
 * Finds the scenarios file of a script that `dwfb simulate`, `dwfb inspect` or `dwfb map` names: the file
 * `--scenarios` names, else the scenarios of the first workflow of the config file whose out is the script, as
 * locate() takes the first.
 * @param {string} script
 * @param {string | undefined} scenariosFile The path `--scenarios` names.
 * @param {string | undefined} configPath The path `--config` names.
 * @returns {Promise<SimulationTarget>}
 */
async function findScriptTarget(script, scenariosFile, configPath) {
  let commandConfig = null;
  let scriptWorkflow;

  if (scenariosFile !== undefined) return { script, scenariosFile, entry: null, map: null };
  commandConfig = await loadCommandConfig(configPath);
  if (commandConfig === null) throw new UsageError(`No config file ${CONFIG_FILES_TEXT} exists here, ${SCENARIOS_FILE_RECOVERY}`);
  [scriptWorkflow] = await findConfigWorkflows(commandConfig.config.workflows, 'out', script);
  if (scriptWorkflow === undefined) throw new UsageError(`The config file ${commandConfig.file} has no workflow whose out is ${script}, ${SCENARIOS_FILE_RECOVERY}`);
  if (scriptWorkflow.scenarios === null) throw new UsageError(`The workflow whose entry is ${formatDisplayPath(scriptWorkflow.entry)} has no scenarios, ${SCENARIOS_FILE_RECOVERY}`);
  await checkBuiltOut(scriptWorkflow, configPath);

  return { ...formatConfigTarget(scriptWorkflow), script };
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
  const { name, expect } = fileScenario;
  const trace = await simulateFileScenario(script, fileScenario, scenariosFile);

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
 * @typedef {SimulationTarget & { file: string | null }} MapTarget A script, its scenarios file and the file its
 *   flow map goes to, or null for stdout.
 */

/**
 * @typedef {object} MappedTarget
 * @property {MapTarget} target
 * @property {import('../src/map.js').MapResult} result
 * @property {string | null} fileLabel The flow map file as formatRealDisplayPath gives it, or null for stdout.
 * @property {string | null} document The flow map, or null when a scenario is unmapped.
 * @property {import('../src/finding.js').Finding[]} findings The findings of a refused script, whose scenarios are
 *   each unmapped with the reason `refused` alone.
 */

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function runMap(args) {
  let parsed = null;
  let targets = null;
  let isSuccess = true;
  const mappedTargets = [];
  const mapChecks = [];
  const writtenFiles = [];

  try {
    parsed = parseArgs({ args, options: MAP_OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    return printUsageError('dwfb map', `${error.message}\n\n${MAP_USAGE}`);
  }

  const { values, positionals } = parsed;
  const [script] = positionals;
  if (values.help) return printResult(MAP_USAGE);
  if (positionals.length > 1 || script === '') return printUsageError('dwfb map', `Name one workflow script.\n\n${MAP_USAGE}`);
  if (values.scenarios === '') return printUsageError('dwfb map', `Name the scenarios file with --scenarios <file>.\n\n${MAP_USAGE}`);
  if (values.out === '') return printUsageError('dwfb map', `Name the flow map file with --out <file>.\n\n${MAP_USAGE}`);
  if (values.config === '') return printUsageError('dwfb map', `Name the config file with --config <path>.\n\n${MAP_USAGE}`);
  if (values.out !== undefined && isFolderPath(values.out)) return printUsageError('dwfb map', `The out path ${values.out} names a folder, so name a file with --out <file>.\n\n${MAP_USAGE}`);
  if (script === undefined && values.scenarios !== undefined) return printUsageError('dwfb map', `Name the script that --scenarios maps.\n\n${MAP_USAGE}`);
  if (script === undefined && values.out !== undefined) return printUsageError('dwfb map', `Name the script whose flow map --out writes.\n\n${MAP_USAGE}`);
  if (values.scenarios !== undefined && values.config !== undefined) return printUsageError('dwfb map', `${SCENARIOS_CONFIG_CONFLICT}.\n\n${MAP_USAGE}`);

  // Every flow map is drawn before any file is written, so a usage error in a later workflow writes nothing.
  try {
    targets = script === undefined ? await findMapTargets(values.config) : [await findScriptMapTarget(script, values)];
    // --json with no --check reads and writes no flow map file, so it skips the checks of the flow map files on disk.
    if (values.check || !values.json) {
      const { configFile, workflows } = values.scenarios === undefined ? await findConfigWorkflowFiles(values.config) : { configFile: null, workflows: targets };
      await checkMapFiles(targets, workflows, configFile);
    }
    for (const target of targets) mappedTargets.push(await mapTarget(target));
    if (values.json) for (const mappedTarget of mappedTargets) mapChecks.push(values.check ? await checkMappedTarget(mappedTarget) : null);
  } catch (error) {
    return printCommandFailure('dwfb map', error);
  }

  if (values.json) {
    isSuccess = mappedTargets.every(({ result }, index) => result.ok && (mapChecks[index] === null || mapChecks[index] === 'fresh'));
    return printResult(`${JSON.stringify(formatMapJson(mappedTargets, mapChecks, isSuccess), null, 2)}\n`, isSuccess ? EXIT_SUCCESS : EXIT_FINDINGS);
  }
  for (const mappedTarget of mappedTargets) {
    let output = null;
    try {
      output = await writeFlowMap(mappedTarget, values.check === true);
    } catch (error) {
      return printCommandFailure('dwfb map', error, await formatWrittenNote(writtenFiles));
    }
    process.stdout.write(output.text);
    if (output.isWritten) writtenFiles.push(/** @type {string} */ (mappedTarget.target.file));
    if (!output.isFresh) isSuccess = false;
  }

  return isSuccess ? EXIT_SUCCESS : EXIT_FINDINGS;
}

/**
 * Finds the targets of `dwfb map` with no script: the out of each workflow of the config file that has map,
 * with its scenarios file and map, in the order the config file lists them, relative to the working directory.
 * @param {string | undefined} configPath
 * @returns {Promise<MapTarget[]>}
 */
async function findMapTargets(configPath) {
  const commandConfig = await loadCommandConfig(configPath);
  const targets = [];

  if (commandConfig === null) throw new UsageError(`No config file ${CONFIG_FILES_TEXT} exists here, so name a script, or name a config file with --config <path>`);
  for (const workflow of commandConfig.config.workflows) {
    if (workflow.map === null) continue;
    await checkBuiltOut(workflow, configPath);
    const target = formatConfigTarget(workflow);
    targets.push({ ...target, file: target.map });
  }
  if (targets.length === 0) throw new UsageError(`The config file ${commandConfig.file} has no workflow with map, so give a workflow map, or name a script`);

  return targets;
}

/**
 * @param {string} script
 * @param {{ scenarios?: string, out?: string, config?: string, check?: boolean }} values The options of the command.
 * @returns {Promise<MapTarget>} The flow map goes to `--out`, else to the map of the config workflow whose out
 *   is the script, else to stdout.
 */
async function findScriptMapTarget(script, values) {
  const target = await findScriptTarget(script, values.scenarios, values.config);
  const file = values.out ?? target.map;
  const noMapReason = values.scenarios === undefined ? 'no map of the config file names one' : 'a named scenarios file reads no config file';

  if (values.check && file === null) throw new UsageError(`Name the flow map file that --check compares with --out <file>, since ${noMapReason}`);

  return { ...target, file };
}

/**
 * @param {MapTarget} target
 * @returns {Promise<MappedTarget>}
 */
async function mapTarget(target) {
  let result = null;
  let fileLabel = null;
  let document = null;
  let findings = [];

  // loadTargetScenarios names the workflow of a scenarios file that does not load, which map() cannot name.
  await loadTargetScenarios(target);
  result = await map({ script: target.script, scenarios: target.scenariosFile });
  if (target.file !== null) fileLabel = await formatRealDisplayPath(target.file);
  if (result.ok) document = formatFlowMap(await readScriptName(target.script), /** @type {import('../src/build-flow-graph.js').FlowGraph} */ (result.graph));
  else findings = (await validate({ script: target.script })).findings;

  return { target, result, fileLabel, document, findings };
}

/**
 * @typedef {object} WorkflowFiles The files of one workflow that a flow map must not replace.
 * @property {string} script
 * @property {string | null} scenariosFile Null for a config workflow with no scenarios.
 * @property {string | null} entry The entry of the config workflow, or null for a script that a named scenarios
 *   file maps, whose banner names its entry.
 * @property {string | null} map The flow map file of the config workflow, or null for none.
 */

/**
 * @param {string | undefined} configPath The path `--config` names.
 * @returns {Promise<{ configFile: string, workflows: WorkflowFiles[] }>} The config file as the messages name it,
 *   and the files of every workflow of the config file, relative to the working directory. The command found its
 *   targets in this config file, and Node keeps the module it loaded.
 */
async function findConfigWorkflowFiles(configPath) {
  const commandConfig = /** @type {{ file: string, config: import('../src/check-config.js').Config }} */ (await loadCommandConfig(configPath));

  return {
    configFile: commandConfig.file,
    workflows: commandConfig.config.workflows.map((workflow) => ({
      script: formatDisplayPath(workflow.out),
      scenariosFile: workflow.scenarios === null ? null : formatDisplayPath(workflow.scenarios),
      entry: formatDisplayPath(workflow.entry),
      map: workflow.map === null ? null : formatDisplayPath(workflow.map),
    })),
  };
}

/**
 * Throws a UsageError for a flow map file that names a script, a scenarios file, a source, the flow map file of
 * another workflow or target, or the config file the command read, by any spelling, such as through a link or in
 * another letter case, since the write would replace that file. checkConfig cannot see a link or a source that an
 * entry reaches. Also throws for a flow map path that names a folder or is inside a file, so that no flow map is
 * written before the refusal.
 * @param {MapTarget[]} targets
 * @param {WorkflowFiles[]} workflows Every workflow of the config file when the command read one, since the entry
 *   of a workflow with no map can reach the file a map names. Else the targets.
 * @param {string | null} configFile The config file the command read, or null when it read none.
 */
async function checkMapFiles(targets, workflows, configFile) {
  const takenFiles = [];
  let targetScripts = new Set();
  let configFiles = [];

  if (targets.every(({ file }) => file === null)) return;
  if (configFile !== null) configFiles = [{ file: await findRealPath(configFile) }];
  targetScripts = new Set(await Promise.all(targets.map(({ script }) => findRealPath(script))));
  for (const workflow of workflows) {
    const scriptFile = await findRealPath(workflow.script);

    takenFiles.push({ file: scriptFile, label: `the script ${workflow.script}` });
    if (workflow.scenariosFile !== null) takenFiles.push({ file: await findRealPath(workflow.scenariosFile), label: `the scenarios file ${workflow.scenariosFile}` });
    // A target may rewrite the flow map file of its own workflow, which the target loop adds in target order.
    if (workflow.map !== null && !targetScripts.has(scriptFile)) {
      takenFiles.push({ file: await findRealPath(workflow.map), label: `the flow map file ${workflow.map} of the script ${workflow.script}` });
    }
    takenFiles.push(...(await findTargetSources(workflow)));
  }
  for (const { script, file } of targets) {
    if (file === null) continue;
    const mapFile = await findRealPath(file);
    // The user wrote each path, or the working directory lookup found the config file. checkConfig refuses two paths
    // that differ only in letter case on every platform, and so does this check.
    const sameConfigFile = findSameFile(configFiles, mapFile);
    const sameFile = findSameFile(takenFiles, mapFile);
    if (sameConfigFile !== undefined) throw new UsageError(formatConfigFileConflict(`The flow map file ${file}`, /** @type {string} */ (configFile), formatCaseNote(sameConfigFile.file, mapFile)));
    if (sameFile !== undefined) throw new UsageError(`The flow map file ${file} names ${sameFile.label}${formatCaseNote(sameFile.file, mapFile)}, which the flow map would replace`);
    await checkOutPath(resolve(file), `The flow map path ${file}`);
    takenFiles.push({ file: mapFile, label: `the flow map file ${file} of the script ${script}` });
  }
}

/**
 * @param {WorkflowFiles} workflow
 * @returns {Promise<{ file: string, label: string }[]>} The real path of the entry the script is built from, and
 *   of each part, module, text file and JSON file the entry reaches, as a build reads them. The entry is the
 *   config workflow's, else the one the script's banner names. An entry that is not a file reaches no source.
 */
async function findTargetSources({ script, entry }) {
  const entryPath = entry ?? (await readBannerEntry(script));
  let entryStats = null;

  if (entryPath === null) return [];
  const entryFile = await findRealPath(entryPath);
  const entryLabel = `the entry ${await formatRealDisplayPath(entryPath)}`;
  try {
    entryStats = await stat(entryFile);
  } catch (error) {
    if (!MISSING_FILE_CODES.has(error.code)) throw error;
  }
  // A missing entry is still a path that the write would create in its place.
  if (entryStats === null || !entryStats.isFile()) return [{ file: entryFile, label: entryLabel }];

  const { sources, parts } = await loadSources(entryFile, true);
  const sourceFiles = [...new Set([...parts, ...sources.keys()])].filter((sourceFile) => sourceFile !== entryFile);
  const sourceLabels = await Promise.all(sourceFiles.map(formatRealDisplayPath));
  return [{ file: entryFile, label: entryLabel }, ...sourceFiles.map((sourceFile, index) => ({ file: sourceFile, label: `the source ${sourceLabels[index]} of ${entryLabel}` }))];
}

/**
 * @param {string} script
 * @returns {Promise<string | null>} The absolute path of the entry that the script's banner names, or null for a
 *   script with no banner, one whose banner names no relative path, and one that cannot be read, whose problem
 *   map() reports.
 */
async function readBannerEntry(script) {
  let bytes = null;

  try {
    ({ bytes } = await readScript(script));
  } catch (error) {
    if (error instanceof UsageError) return null;
    throw error;
  }
  if (bytes === null) return null;
  // The runtime of Claude Code 2.1.332 decodes the file with toString('utf-8'), as map() reads it.
  const banner = findBanner(bytes.toString('utf8'));
  // The build gives the banner path relative to the real path of the script's folder, as locate() reads it.
  if (banner.path === null || parse(banner.path).root !== '') return null;

  return resolve(await findRealPath(dirname(resolve(script))), banner.path);
}

/**
 * @param {string} script A script that map() mapped, so it breaks no rule of the contract.
 * @returns {Promise<string>} The `name` of its meta object, which the meta-name-invalid rule makes a string.
 */
async function readScriptName(script) {
  const { bytes } = await readScript(script);
  // The runtime of Claude Code 2.1.332 decodes the file with toString('utf-8'), as map() reads it.
  const meta = readMetaValue(parseSource(/** @type {Buffer} */ (bytes).toString('utf8'), PARSE_OPTIONS));

  return /** @type {string} */ (meta?.name);
}

/**
 * Writes, compares or prints one flow map.
 * @param {MappedTarget} mappedTarget
 * @param {boolean} isCheck
 * @returns {Promise<{ text: string, isFresh: boolean, isWritten: boolean }>} The text a person reads, false for an
 *   unmapped scenario or a stale file, and true when the file was written.
 */
async function writeFlowMap({ target, result, fileLabel, document, findings }, isCheck) {
  if (document === null) {
    const lines = [...findings.map(formatFinding), ...result.unmapped.map(({ scenario, reason }) => `${result.script} ${formatHiddenCharacters(scenario)}: not mapped, since ${reason}.`)];
    return { text: lines.map((line) => `${line}\n`).join(''), isFresh: false, isWritten: false };
  }
  if (target.file === null) return { text: document, isFresh: true, isWritten: false };

  const fileCheck = await compareFlowMapFile(target.file, document);
  if (isCheck && fileCheck === 'missing') return { text: `Stale ${fileLabel}: the file is missing.\n`, isFresh: false, isWritten: false };
  if (isCheck && fileCheck === 'stale') return { text: `Stale ${fileLabel}: the file differs from the flow map of ${result.script}.\n`, isFresh: false, isWritten: false };
  if (isCheck) return { text: `Fresh ${fileLabel}.\n`, isFresh: true, isWritten: false };
  if (fileCheck === 'fresh') return { text: `Unchanged ${fileLabel}.\n`, isFresh: true, isWritten: false };

  await writeScript(resolve(target.file), document);
  return { text: `Wrote ${fileLabel}.\n`, isFresh: true, isWritten: true };
}

/**
 * @typedef {'fresh' | 'stale' | 'missing'} MapCheck How a flow map file compares with its flow map.
 */

/**
 * @param {MappedTarget} mappedTarget A target of `dwfb map --check`, whose flow map file is not null.
 * @returns {Promise<MapCheck | null>} Null for a script with an unmapped scenario, which has no flow map to compare.
 */
async function checkMappedTarget({ target, document }) {
  if (document === null) return null;

  return compareFlowMapFile(/** @type {string} */ (target.file), document);
}

/**
 * @param {string} file
 * @param {string} document The flow map.
 * @returns {Promise<MapCheck>}
 */
async function compareFlowMapFile(file, document) {
  const fileBytes = await readExistingFile(file);

  if (fileBytes === null) return 'missing';
  return fileBytes.equals(Buffer.from(document, 'utf8')) ? 'fresh' : 'stale';
}

/**
 * @param {string} file
 * @returns {Promise<Buffer | null>} The bytes of the file, or null when no file exists at the path.
 */
async function readExistingFile(file) {
  try {
    return await readFile(resolve(file));
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) return null;
    throw error;
  }
}

/**
 * @param {MappedTarget[]} mappedTargets In the order mapped.
 * @param {(MapCheck | null)[]} mapChecks The `check` key of each map in the same order: how its flow map file
 *   compares with `--check`, and null with no `--check` and for a script with an unmapped scenario.
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape, which is part of the public interface.
 */
function formatMapJson(mappedTargets, mapChecks, isSuccess) {
  return {
    ok: isSuccess,
    runtime: CONTRACT_RUNTIME_VERSION,
    maps: mappedTargets.map(({ result, fileLabel, findings }, index) => ({ script: result.script, file: fileLabel, check: mapChecks[index], ...result, findings })),
  };
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
 * @returns {Promise<{ configFile: string | null, workflows: { entry: string, out: string, banner: boolean, validate: boolean, scenarios?: string | null }[] }>}
 *   The config file as the messages name it, or null for the `--out` workflow, which reads none. A config
 *   workflow keeps its absolute scenarios path.
 */
async function findWorkflows(entry, out, configPath) {
  if (out !== undefined) return { configFile: null, workflows: [{ entry, out, banner: true, validate: true }] };
  const commandConfig = await loadCommandConfig(configPath);
  if (commandConfig === null) {
    const missingWhat = entry === undefined ? 'an entry file' : 'the built script with --out <file>';
    throw new UsageError(`No config file ${CONFIG_FILES_TEXT} exists here, so name ${missingWhat}`);
  }

  const configWorkflows = commandConfig.config.workflows.map((workflow) => ({ ...workflow, entry: formatDisplayPath(workflow.entry), out: formatDisplayPath(workflow.out) }));
  if (entry === undefined) return { configFile: commandConfig.file, workflows: configWorkflows };

  const entryWorkflows = await findConfigWorkflows(configWorkflows, 'entry', entry);
  if (entryWorkflows.length === 0) throw new UsageError(`The config file ${commandConfig.file} has no workflow whose entry is ${entry}`);

  return { configFile: commandConfig.file, workflows: entryWorkflows };
}

/**
 * build() refuses an `out` that is a source of its own workflow. This extends the refusal to the sources of
 * every workflow the command builds, since the command writes each script after every workflow builds. It
 * also refuses two workflows whose `out` paths name one file through a link, and an `out` that names the
 * scenarios file of a workflow the command builds or the config file the command read through a link, which
 * checkConfig cannot see.
 * @param {{ workflow: { entry: string, out: string, scenarios?: string | null }, result: import('../src/build.js').BuildResult }[]} builtWorkflows
 * @param {string | null} configFile The config file the command read, or null when it read none.
 */
async function checkOutFiles(builtWorkflows, configFile) {
  // build() gives each source relative to the working directory's real path.
  const workFolder = await realpath(process.cwd());
  const configFiles = configFile === null ? [] : [{ file: await findRealPath(configFile) }];
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
    // The user wrote each path, or the working directory lookup found the config file. checkConfig refuses two out
    // paths that differ only in letter case on every platform, and so does this check.
    const scenariosFile = findSameFile(scenariosFiles, outFile);
    const sameOutFile = findSameFile(outFiles, outFile);
    const sameConfigFile = findSameFile(configFiles, outFile);
    const outLabel = `The out file ${formatDisplayPath(workflow.out)} of the workflow whose entry is ${formatDisplayPath(workflow.entry)}`;
    if (sameConfigFile !== undefined) throw new UsageError(formatConfigFileConflict(outLabel, /** @type {string} */ (configFile), formatCaseNote(sameConfigFile.file, outFile)));
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
 * @param {string} pathLabel The path the command would write, such as `The flow map file docs/flow.md`.
 * @param {string} configFile The config file the command read, as the messages name it.
 * @param {string} caseNote What formatCaseNote gives for the two real paths.
 * @returns {string} The message of `dwfb build` and `dwfb map` for a write that would replace the config file.
 */
function formatConfigFileConflict(pathLabel, configFile, caseNote) {
  return `${pathLabel} names the config file ${configFile}${caseNote}, which the write would replace`;
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
 * @param {string[]} writtenFiles Each file written before a failure, in write order.
 * @returns {Promise<string>} The sentence that names each file, or '' when none was written.
 */
async function formatWrittenNote(writtenFiles) {
  const writtenPaths = [];
  for (const file of writtenFiles) writtenPaths.push(await formatFailedPath(file));
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
