import { CONFIG_FILES_TEXT, loadCommandConfig } from '../src/load-config.js';
import { UsageError } from '../src/usage-error.js';
import { checkBuiltOut } from './check-built-out.js';
import { formatConfigTarget } from './find-script-target.js';

/**
 * Finds the script and scenarios file of each workflow that `dwfb simulate` or `dwfb cover` with no script runs:
 * the out of each workflow of the config file that has scenarios, with its scenarios file, in the order the config
 * file lists them, relative to the working directory.
 * @param {string | undefined} configPath The path `--config` names.
 * @returns {Promise<import('./find-script-target.js').SimulationTarget[]>}
 */
export async function findConfigTargets(configPath) {
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
