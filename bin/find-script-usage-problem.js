export const ONE_SCRIPT_PROBLEM = 'Name one workflow script';
const SCENARIOS_CONFIG_CONFLICT = 'Name --scenarios or --config, not both, since a named scenarios file needs no config file';

/**
 * @typedef {object} ScriptValues The options that every command which runs a script against its scenarios reads.
 * @property {string} [scenarios]
 * @property {string} [config]
 */

/**
 * @typedef {object} CommandChecks The checks of a command's other options. The place of each among the shared checks
 *   sets which usage error an input with two usage problems prints.
 * @property {() => string | null} [findEmptyValueProblem] Runs after the empty `--scenarios` check and before the
 *   empty `--config` check.
 * @property {() => string | null} [findValueProblem] Runs after the empty `--config` check.
 * @property {() => string | null} [findMissingScriptProblem] Runs after the check of `--scenarios` with no script
 *   and before the check of `--scenarios` with `--config`.
 */

/**
 * Checks the script and the `--scenarios` and `--config` options of `dwfb simulate`, `dwfb inspect`, `dwfb map`,
 * `dwfb snapshot` or `dwfb cover`, and runs the checks the command passes for its other options.
 * @param {ScriptValues} values
 * @param {string[]} positionals
 * @param {string} verb What the command does to a script, such as `covers`.
 * @param {CommandChecks} [commandChecks]
 * @returns {string | null} The usage error, with no full stop, or null for none.
 */
export function findScriptUsageProblem(values, positionals, verb, commandChecks = {}) {
  const [script] = positionals;
  let commandProblem = null;

  if (positionals.length > 1 || script === '') return ONE_SCRIPT_PROBLEM;
  if (values.scenarios === '') return 'Name the scenarios file with --scenarios <file>';
  commandProblem = commandChecks.findEmptyValueProblem?.() ?? null;
  if (commandProblem !== null) return commandProblem;
  if (values.config === '') return 'Name the config file with --config <path>';
  commandProblem = commandChecks.findValueProblem?.() ?? null;
  if (commandProblem !== null) return commandProblem;
  if (script === undefined && values.scenarios !== undefined) return `Name the script that --scenarios ${verb}`;
  commandProblem = commandChecks.findMissingScriptProblem?.() ?? null;
  if (commandProblem !== null) return commandProblem;
  if (values.scenarios !== undefined && values.config !== undefined) return SCENARIOS_CONFIG_CONFLICT;
  return null;
}
