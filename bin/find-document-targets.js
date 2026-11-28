import { CONFIG_FILES_TEXT, loadCommandConfig } from '../src/load-config.js';
import { UsageError } from '../src/usage-error.js';
import { checkBuiltOut } from './check-built-out.js';
import { findScriptTarget, formatConfigTarget } from './find-script-target.js';

/** @typedef {import('./document-kinds.js').DocumentKind} DocumentKind */

/**
 * @typedef {import('./find-script-target.js').SimulationTarget & { file: string | null }} DocumentTarget A script,
 *   its scenarios file and the file its document goes to, or null for stdout.
 */

/**
 * Finds the targets of `dwfb map` or `dwfb snapshot`: the script the command names, else the out of each workflow
 * of the config file that names the document file, in the order the config file lists them.
 * @param {DocumentKind} kind
 * @param {string | undefined} script
 * @param {import('./parse-document-args.js').DocumentValues} values
 * @returns {Promise<DocumentTarget[]>} With each path relative to the working directory.
 */
export async function findDocumentTargets(kind, script, values) {
  if (script !== undefined) return [await findScriptDocumentTarget(kind, script, values)];
  return findConfigDocumentTargets(kind, values.config);
}

/**
 * @param {DocumentKind} kind
 * @param {string | undefined} configPath
 * @returns {Promise<DocumentTarget[]>}
 */
async function findConfigDocumentTargets(kind, configPath) {
  const commandConfig = await loadCommandConfig(configPath);
  const targets = [];

  if (commandConfig === null) throw new UsageError(`No config file ${CONFIG_FILES_TEXT} exists here, so name a script, or name a config file with --config <path>`);
  for (const workflow of commandConfig.config.workflows) {
    if (workflow[kind.key] === null) continue;
    await checkBuiltOut(workflow, configPath);
    const target = formatConfigTarget(workflow);
    targets.push({ ...target, file: target[kind.key] });
  }
  if (targets.length === 0) throw new UsageError(`The config file ${commandConfig.file} has no workflow with ${kind.key}, so give a workflow ${kind.key}, or name a script`);

  return targets;
}

/**
 * @param {DocumentKind} kind
 * @param {string} script
 * @param {import('./parse-document-args.js').DocumentValues} values
 * @returns {Promise<DocumentTarget>} The document goes to `--out`, else to the document file of the config workflow
 *   whose out is the script, else to stdout.
 */
async function findScriptDocumentTarget(kind, script, values) {
  const target = await findScriptTarget(script, values.scenarios, values.config);
  const file = values.out ?? target[kind.key];
  const noFileReason = values.scenarios === undefined ? `no ${kind.key} of the config file names one` : 'a named scenarios file reads no config file';

  if (values.check && file === null) throw new UsageError(`Name the ${kind.name} file that --check compares with --out <file>, since ${noFileReason}`);

  return { ...target, file };
}
