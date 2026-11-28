import { formatDisplayPath } from '../src/display-path.js';
import { findConfigWorkflows } from '../src/find-config-workflows.js';
import { CONFIG_FILES_TEXT, loadCommandConfig } from '../src/load-config.js';
import { UsageError } from '../src/usage-error.js';
import { checkBuiltOut } from './check-built-out.js';

const SCENARIOS_FILE_RECOVERY = 'so name the scenarios file with --scenarios <file>';

/**
 * @typedef {object} SimulationTarget One script and the scenarios file it runs against.
 * @property {string} script
 * @property {string} scenariosFile
 * @property {string | null} entry The entry of the config workflow that names the scenarios file, or null for
 *   a scenarios file that `--scenarios` names.
 * @property {string | null} map The map of that config workflow, or null for a workflow with no map and for a
 *   scenarios file that `--scenarios` names.
 * @property {string | null} snapshot The snapshot of that config workflow, or null as for `map`.
 * @property {Record<string, number> | null} promptBudgets The promptBudgets of that config workflow, or null as
 *   for `map`.
 */

/**
 * Finds the scenarios file of a script that `dwfb simulate`, `dwfb inspect`, `dwfb map`, `dwfb snapshot` or
 * `dwfb cover` names: the file `--scenarios` names, else the scenarios of the first workflow of the config file whose out is
 * the script, as locate() takes the first.
 * @param {string} script
 * @param {string | undefined} scenariosFile The path `--scenarios` names.
 * @param {string | undefined} configPath The path `--config` names.
 * @returns {Promise<SimulationTarget>}
 */
export async function findScriptTarget(script, scenariosFile, configPath) {
  let commandConfig = null;
  let scriptWorkflow;

  if (scenariosFile !== undefined) return { script, scenariosFile, entry: null, map: null, snapshot: null, promptBudgets: null };
  commandConfig = await loadCommandConfig(configPath);
  if (commandConfig === null) throw new UsageError(`No config file ${CONFIG_FILES_TEXT} exists here, ${SCENARIOS_FILE_RECOVERY}`);
  [scriptWorkflow] = await findConfigWorkflows(commandConfig.config.workflows, 'out', script);
  if (scriptWorkflow === undefined) throw new UsageError(`The config file ${commandConfig.file} has no workflow whose out is ${script}, ${SCENARIOS_FILE_RECOVERY}`);
  if (scriptWorkflow.scenarios === null) throw new UsageError(`The workflow whose entry is ${formatDisplayPath(scriptWorkflow.entry)} has no scenarios, ${SCENARIOS_FILE_RECOVERY}`);
  await checkBuiltOut(scriptWorkflow, configPath);

  return { ...formatConfigTarget(scriptWorkflow), script };
}

/**
 * @param {import('../src/check-config.js').ConfigWorkflow} workflow A workflow with scenarios.
 * @returns {SimulationTarget} With each path relative to the working directory.
 */
export function formatConfigTarget(workflow) {
  return {
    script: formatDisplayPath(workflow.out),
    scenariosFile: formatDisplayPath(/** @type {string} */ (workflow.scenarios)),
    entry: formatDisplayPath(workflow.entry),
    map: workflow.map === null ? null : formatDisplayPath(workflow.map),
    snapshot: workflow.snapshot === null ? null : formatDisplayPath(workflow.snapshot),
    promptBudgets: workflow.promptBudgets,
  };
}
