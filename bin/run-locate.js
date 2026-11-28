import { parseArgs } from 'node:util';
import { formatLocateText } from '../src/format-locate-text.js';
import { CONFIG_FILES_TEXT } from '../src/load-config.js';
import { locate } from '../src/locate.js';
import { EXIT_FINDINGS, EXIT_SUCCESS, printCommandFailure, printResult, printUsageError } from './print-result.js';

const SCRIPT_POSITION_PATTERN = /^(?<line>\d+)(?::(?<column>\d+))?$/;

const LOCATE_USAGE = `Usage: dwfb locate <script> <line>[:<column>] [options]

Prints the source file, line and column that a line of a built script comes from, then the source line.
The command builds the script in memory from the entry that its banner names, or with no banner from the
workflow of the config file whose out is the script.

Options:
  --runtime         Read the line and column as the runtime reports them, as in workflow.js:5:9.
  --entry <file>    Build the script from this entry.
  --config <path>   Read this config file in place of ${CONFIG_FILES_TEXT}.
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

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function runLocate(args) {
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
