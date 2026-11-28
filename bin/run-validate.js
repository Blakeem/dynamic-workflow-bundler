import { parseArgs } from 'node:util';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatDisplayPath } from '../src/display-path.js';
import { formatValidateJson } from '../src/format-validate-json.js';
import { formatValidateText } from '../src/format-validate-text.js';
import { CONFIG_FILES_TEXT, loadCommandConfig } from '../src/load-config.js';
import { formatRealDisplayPath } from '../src/real-path.js';
import { UsageError } from '../src/usage-error.js';
import { validate } from '../src/validate.js';
import { checkBuiltOut } from './check-built-out.js';
import { EMPTY_CONFIG_PROBLEM } from './find-script-usage-problem.js';
import { EXIT_FINDINGS, EXIT_SUCCESS, printCommandFailure, printResult, printUsageError } from './print-result.js';

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

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function runValidate(args) {
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
  if (values.config === '') return printUsageError('dwfb validate', `${EMPTY_CONFIG_PROBLEM}.\n\n${VALIDATE_USAGE}`);
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
  return printResult(formatValidateText(results, skipped), exitCode);
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
