export const ONE_SCRIPT_PROBLEM = 'Name one workflow script';
export const EMPTY_CONFIG_PROBLEM = 'Name the config file with --config <path>';
const SCENARIOS_CONFIG_CONFLICT = 'Name --scenarios or --config, not both, since a named scenarios file needs no config file';

/**
 * @typedef {object} ScriptValues The options that every command which runs a script against its scenarios reads.
 * @property {string} [scenarios]
 * @property {string} [config]
 */

/**
 * Checks the script and the `--scenarios` and `--config` options of `dwfb simulate`, `dwfb inspect`, `dwfb map`,
 * `dwfb snapshot` or `dwfb cover`. Each command checks its other options after this check gives null.
 * @param {ScriptValues} values
 * @param {string[]} positionals
 * @param {string} verb What the command does to a script, such as `covers`.
 * @returns {string | null} The usage error, with no full stop, or null for none.
 */
export function findScriptUsageProblem(values, positionals, verb) {
  const [script] = positionals;

  if (positionals.length > 1 || script === '') return ONE_SCRIPT_PROBLEM;
  if (values.scenarios === '') return 'Name the scenarios file with --scenarios <file>';
  if (values.config === '') return EMPTY_CONFIG_PROBLEM;
  if (script === undefined && values.scenarios !== undefined) return `Name the script that --scenarios ${verb}`;
  if (values.scenarios !== undefined && values.config !== undefined) return SCENARIOS_CONFIG_CONFLICT;
  return null;
}
