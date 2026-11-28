import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from '../src/build.js';
import { formatBuildCommand } from '../src/build-command.js';
import { checkExistingScript } from '../src/check-existing-script.js';
import { formatDisplayPath } from '../src/display-path.js';
import { findConfigWorkflows } from '../src/find-config-workflows.js';
import { findSameFile } from '../src/find-same-file.js';
import { formatBuildJson } from '../src/format-build-json.js';
import { formatBuildText } from '../src/format-build-text.js';
import { formatCaseNote, formatConfigFileConflict } from '../src/format-path-conflict.js';
import { CONFIG_FILES_TEXT, loadCommandConfig } from '../src/load-config.js';
import { findRealPath, formatRealDisplayPath } from '../src/real-path.js';
import { UsageError } from '../src/usage-error.js';
import { writeScript } from '../src/write-script.js';
import { EMPTY_CONFIG_PROBLEM } from './find-script-usage-problem.js';
import { EXIT_FINDINGS, EXIT_SUCCESS, formatWrittenNote, printCommandFailure, printResult, printUsageError } from './print-result.js';

const BUILD_USAGE = `Usage: dwfb build [<entry>] [--out <file>] [options]

With no entry, builds every workflow of the config file. With an entry and no --out, builds each
workflow of the config file that has this entry. With an entry and --out, reads no config file.

Options:
  --out <file>      Write the built script to this file.
                    An existing file must be a built script.
  --config <path>   Read this config file in place of ${CONFIG_FILES_TEXT}.
  --check           Write nothing, and report each built script that differs from its source.
  --no-banner       Leave out the banner line.
                    Such a build can replace a hand-written workflow script.
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

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function runBuild(args) {
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
  if (values.config === '') return printUsageError('dwfb build', `${EMPTY_CONFIG_PROBLEM}.\n\n${BUILD_USAGE}`);
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
      builtWorkflows.push({ workflow, banner, result: await build({ entry: workflow.entry, out: workflow.out, banner, check: values.check === true, write: false, validate }), out: null });
    } catch (error) {
      return printCommandFailure('dwfb build', error);
    }
  }
  try {
    await checkOutFiles(builtWorkflows, configFile);
    for (const { workflow, banner, result } of builtWorkflows) {
      if (result.status === 'built') await checkExistingScript(resolve(workflow.out), workflow.out, banner);
    }
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
