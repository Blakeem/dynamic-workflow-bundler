import { stat } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';
import { findBanner } from '../src/banner.js';
import { checkOutPath } from '../src/check-out-path.js';
import { formatDisplayPath } from '../src/display-path.js';
import { findSameFile } from '../src/find-same-file.js';
import { formatCaseNote, formatConfigFileConflict } from '../src/format-path-conflict.js';
import { loadCommandConfig } from '../src/load-config.js';
import { loadSources, MISSING_FILE_CODES } from '../src/load-sources.js';
import { readScript } from '../src/read-script.js';
import { findRealPath, formatRealDisplayPath } from '../src/real-path.js';
import { UsageError } from '../src/usage-error.js';
import { DOCUMENT_KINDS } from './document-kinds.js';

/** @typedef {import('./document-kinds.js').DocumentKind} DocumentKind */
/** @typedef {import('./find-document-targets.js').DocumentTarget} DocumentTarget */

/**
 * @typedef {object} WorkflowFiles The files of one workflow that a document must not replace.
 * @property {string} script
 * @property {string | null} scenariosFile Null for a config workflow with no scenarios.
 * @property {string | null} entry The entry of the config workflow, or null for a script that the command reads
 *   with a named scenarios file, whose banner names its entry.
 * @property {string | null} map The flow map file of the config workflow, or null for none.
 * @property {string | null} snapshot The prompt snapshot file of the config workflow, or null for none.
 */

/**
 * Throws a UsageError for a document file that names a script, a scenarios file, a source, a document file of
 * another kind of any workflow, a document file of the same kind of another workflow or target, or the config file
 * the command read, by any spelling, such as through a link or in another letter case, since the write would
 * replace that file. checkConfig cannot see a link or a source that an entry reaches. Also throws for a document
 * path that names a folder or is inside a file, so that no document is written before the refusal.
 * @param {DocumentKind} kind
 * @param {DocumentTarget[]} targets
 * @param {import('./parse-document-args.js').DocumentValues} values The options of the command.
 */
export async function checkDocumentFiles(kind, targets, values) {
  let configFile = null;
  let workflows = targets;

  // --json with no --check reads and writes no document file, so it skips the checks of the document files on disk.
  if (values.json && !values.check) return;
  if (values.scenarios === undefined) ({ configFile, workflows } = await findConfigWorkflowFiles(values.config));
  await checkTargetFiles(kind, targets, workflows, configFile);
}

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
      snapshot: workflow.snapshot === null ? null : formatDisplayPath(workflow.snapshot),
    })),
  };
}

/**
 * @param {DocumentKind} kind
 * @param {DocumentTarget[]} targets
 * @param {WorkflowFiles[]} workflows Every workflow of the config file when the command read one, since the entry
 *   of a workflow with no document file can reach the file a document file names. Else the targets.
 * @param {string | null} configFile The config file the command read, or null when it read none.
 */
async function checkTargetFiles(kind, targets, workflows, configFile) {
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
    for (const documentKind of DOCUMENT_KINDS) {
      const documentFile = workflow[documentKind.key];
      // A target may rewrite the document file of its own workflow, which the target loop adds in target order.
      if (documentFile === null || (documentKind === kind && targetScripts.has(scriptFile))) continue;
      takenFiles.push({ file: await findRealPath(documentFile), label: `the ${documentKind.name} file ${documentFile} of the script ${workflow.script}` });
    }
    takenFiles.push(...(await findTargetSources(workflow)));
  }
  for (const { script, file } of targets) {
    if (file === null) continue;
    const documentFile = await findRealPath(file);
    // The user wrote each path, or the working directory lookup found the config file. checkConfig refuses two paths
    // that differ only in letter case on every platform, and so does this check.
    const sameConfigFile = findSameFile(configFiles, documentFile);
    const sameFile = findSameFile(takenFiles, documentFile);
    if (sameConfigFile !== undefined) throw new UsageError(formatConfigFileConflict(`The ${kind.name} file ${file}`, /** @type {string} */ (configFile), formatCaseNote(sameConfigFile.file, documentFile)));
    if (sameFile !== undefined) throw new UsageError(`The ${kind.name} file ${file} names ${sameFile.label}${formatCaseNote(sameFile.file, documentFile)}, which the ${kind.name} would replace`);
    await checkOutPath(resolve(file), `The ${kind.name} path ${file}`);
    takenFiles.push({ file: documentFile, label: `the ${kind.name} file ${file} of the script ${script}` });
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
 *   the command reports when it runs the script.
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
  // The runtime of Claude Code 2.1.332 decodes the file with toString('utf-8'), as map() and snapshot() read it.
  const banner = findBanner(bytes.toString('utf8'));
  // The build gives the banner path relative to the real path of the script's folder, as locate() reads it.
  if (banner.path === null || parse(banner.path).root !== '') return null;

  return resolve(await findRealPath(dirname(resolve(script))), banner.path);
}
