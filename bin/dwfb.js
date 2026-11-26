#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from '../src/build.js';
import { formatBuildCommand } from '../src/build-command.js';
import { formatDisplayPath } from '../src/display-path.js';
import { findConfigWorkflows } from '../src/find-config-workflows.js';
import { formatFinding } from '../src/format-finding.js';
import { CONFIG_FILE, loadConfig } from '../src/load-config.js';
import { locate } from '../src/locate.js';
import { findRealPath } from '../src/real-path.js';
import { UsageError } from '../src/usage-error.js';
import { writeScript } from '../src/write-script.js';

const EXIT_SUCCESS = 0;
const EXIT_FINDINGS = 1;
const EXIT_FAILURE = 2;
const SCRIPT_POSITION_PATTERN = /^(?<line>\d+)(?::(?<column>\d+))?$/;

const MAIN_USAGE = `Usage: dwfb <command> [options]

Commands:
  build [<entry>] [--out <file>]   Build workflow scripts from an entry, its parts, and the modules,
                                   text files and JSON files it imports.
  locate <script> <line>[:<column>]
                                   Print the source line that a line of a built script comes from.

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
  --config <path>   Read this config file in place of ${CONFIG_FILE}.
  --check           Write nothing, and report each built script that differs from its source.
  --no-banner       Leave out the banner line.
  --json            Print the result as one JSON object.
  --help            Print this help.
`;

const BUILD_OPTIONS = Object.freeze({
  out: { type: 'string' },
  config: { type: 'string' },
  check: { type: 'boolean' },
  'no-banner': { type: 'boolean' },
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
  --config <path>   Read this config file in place of ${CONFIG_FILE}.
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

const SUCCESS_STATUSES = new Set(['written', 'fresh']);

process.exitCode = await runCommand(process.argv.slice(2));

/**
 * @param {string[]} args
 * @returns {Promise<number>} The exit code.
 */
async function runCommand(args) {
  const [command, ...commandArgs] = args;

  const isMainOption = command === '--version' || command === '--help';

  if (command === 'build') return runBuild(commandArgs);
  if (command === 'locate') return runLocate(commandArgs);
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
    try {
      builtWorkflows.push({ workflow, result: await build({ entry: workflow.entry, out: workflow.out, banner, check: values.check === true, write: false }) });
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
    if (builtWorkflow.result.status === 'built') {
      try {
        await writeScript(resolve(builtWorkflow.workflow.out), builtWorkflow.result.script);
      } catch (error) {
        return printCommandFailure('dwfb build', error);
      }
      builtWorkflow.result = { ...builtWorkflow.result, status: 'written' };
    }
    if (!values.json) process.stdout.write(formatBuildText(builtWorkflow.workflow, builtWorkflow.result, buildCommand));
  }

  const isSuccess = builtWorkflows.every(({ result }) => SUCCESS_STATUSES.has(result.status));
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
 * Finds the workflows one `dwfb build` builds. A config file's workflows get paths relative to the working
 * directory, and the `--out` workflow keeps the paths as the user typed them.
 * @param {string | undefined} entry
 * @param {string | undefined} out
 * @param {string | undefined} configPath
 * @returns {Promise<{ entry: string, out: string, banner: boolean }[]>}
 */
async function findWorkflows(entry, out, configPath) {
  if (out !== undefined) return [{ entry, out, banner: true }];
  if (configPath === undefined && !existsSync(CONFIG_FILE)) {
    const missingWhat = entry === undefined ? 'an entry file' : 'the built script with --out <file>';
    throw new UsageError(`No config file ${CONFIG_FILE} exists here, so name ${missingWhat}`);
  }

  const config = await loadConfig(configPath ?? CONFIG_FILE);
  const configWorkflows = config.workflows.map((workflow) => ({ ...workflow, entry: formatDisplayPath(workflow.entry), out: formatDisplayPath(workflow.out) }));
  if (entry === undefined) return configWorkflows;

  const entryWorkflows = await findConfigWorkflows(configWorkflows, 'entry', entry);
  if (entryWorkflows.length === 0) throw new UsageError(`The config file ${configPath ?? CONFIG_FILE} has no workflow whose entry is ${entry}`);

  return entryWorkflows;
}

/**
 * build() refuses an `out` that is a source of its own workflow. This extends the refusal to the sources of
 * every workflow the command builds, since the command writes each script after every workflow builds. It
 * also refuses two workflows whose `out` paths name one file through a link, which checkConfig cannot see.
 * @param {{ workflow: { entry: string, out: string }, result: import('../src/build.js').BuildResult }[]} builtWorkflows
 */
async function checkOutFiles(builtWorkflows) {
  // build() gives each source relative to the working directory's real path.
  const workFolder = await realpath(process.cwd());
  const sourceWorkflows = new Map();
  const outWorkflows = new Map();

  for (const { workflow, result } of builtWorkflows) {
    for (const source of result.sources) {
      const sourceFile = resolve(workFolder, source);
      if (!sourceWorkflows.has(sourceFile)) sourceWorkflows.set(sourceFile, workflow);
    }
  }
  for (const { workflow } of builtWorkflows) {
    const outFile = await findRealPath(workflow.out);
    // checkConfig refuses two out paths that differ only in letter case on every platform, and so does this check.
    const outKey = outFile.toLowerCase();
    const sourceWorkflow = sourceWorkflows.get(outFile);
    const outWorkflow = outWorkflows.get(outKey);
    const outLabel = `The out file ${formatDisplayPath(workflow.out)} of the workflow whose entry is ${formatDisplayPath(workflow.entry)}`;
    if (sourceWorkflow !== undefined) throw new UsageError(`${outLabel} is a source of the workflow whose entry is ${formatDisplayPath(sourceWorkflow.entry)}`);
    if (outWorkflow !== undefined) {
      throw new UsageError(`${outLabel} names the same file as the out file ${formatDisplayPath(outWorkflow.out)} of the workflow whose entry is ${formatDisplayPath(outWorkflow.entry)}`);
    }
    outWorkflows.set(outKey, workflow);
  }
}

/**
 * @param {{ out: string }} workflow
 * @param {import('../src/build.js').BuildResult} result
 * @param {string} buildCommand The command that rewrites a script that differs or is missing.
 * @returns {string} The lines a person reads for one workflow.
 */
function formatBuildText(workflow, result, buildCommand) {
  const out = formatDisplayPath(workflow.out);

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
 * @param {{ workflow: { entry: string, out: string }, result: import('../src/build.js').BuildResult }[]} builtWorkflows
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape, which is part of the public interface.
 */
function formatBuildJson(builtWorkflows, isSuccess) {
  return {
    ok: isSuccess,
    workflows: builtWorkflows.map(({ workflow, result }) => ({
      entry: formatDisplayPath(workflow.entry),
      out: formatDisplayPath(workflow.out),
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
 * @returns {number}
 */
function printCommandFailure(label, error) {
  if (error instanceof UsageError) return printUsageError(label, `${error.message}.\n`);
  if (isFileSystemError(error)) {
    process.stderr.write(`${label}: Could not read or write ${formatDisplayPath(error.path)} (${error.syscall} ${error.code}).\n`);
    return EXIT_FAILURE;
  }
  process.stderr.write(`${label}: internal failure.\n${error.stack ?? error}\n`);
  return EXIT_FAILURE;
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
