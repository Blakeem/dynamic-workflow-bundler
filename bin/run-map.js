import { readFile, stat } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findBanner } from '../src/banner.js';
import { checkOutPath } from '../src/check-out-path.js';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatDisplayPath, isFolderPath } from '../src/display-path.js';
import { findSameFile } from '../src/find-same-file.js';
import { formatFinding } from '../src/format-finding.js';
import { formatFlowMap } from '../src/format-flow-map.js';
import { formatHiddenCharacters } from '../src/format-hidden-characters.js';
import { formatMapJson } from '../src/format-map-json.js';
import { formatCaseNote, formatConfigFileConflict } from '../src/format-path-conflict.js';
import { CONFIG_FILES_TEXT, loadCommandConfig } from '../src/load-config.js';
import { loadSources, MISSING_FILE_CODES } from '../src/load-sources.js';
import { map } from '../src/map.js';
import { PARSE_OPTIONS, parseSource } from '../src/parse-source.js';
import { readMetaValue } from '../src/read-meta-value.js';
import { readScript } from '../src/read-script.js';
import { findRealPath, formatRealDisplayPath } from '../src/real-path.js';
import { UsageError } from '../src/usage-error.js';
import { validate } from '../src/validate.js';
import { writeScript } from '../src/write-script.js';
import { checkBuiltOut } from './check-built-out.js';
import { findScriptTarget, formatConfigTarget, SCENARIOS_CONFIG_CONFLICT } from './find-script-target.js';
import { loadTargetScenarios } from './load-target-scenarios.js';
import { EXIT_FINDINGS, EXIT_SUCCESS, formatWrittenNote, printCommandFailure, printResult, printUsageError } from './print-result.js';

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

/**
 * @typedef {import('./find-script-target.js').SimulationTarget & { file: string | null }} MapTarget A script, its
 *   scenarios file and the file its flow map goes to, or null for stdout.
 */

/**
 * @typedef {import('../src/format-map-json.js').MapJsonTarget & { target: MapTarget, document: string | null }} MappedTarget
 *   With the flow map in `document`, or null when a scenario is unmapped.
 */

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function runMap(args) {
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
 * @param {MappedTarget} mappedTarget A target of `dwfb map --check`, whose flow map file is not null.
 * @returns {Promise<import('../src/format-map-json.js').MapCheck | null>} Null for a script with an unmapped
 *   scenario, which has no flow map to compare.
 */
async function checkMappedTarget({ target, document }) {
  if (document === null) return null;

  return compareFlowMapFile(/** @type {string} */ (target.file), document);
}

/**
 * @param {string} file
 * @param {string} document The flow map.
 * @returns {Promise<import('../src/format-map-json.js').MapCheck>}
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
