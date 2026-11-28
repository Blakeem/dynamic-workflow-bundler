import { parseArgs } from 'node:util';
import { isFolderPath } from '../src/display-path.js';
import { findScriptUsageProblem } from './find-script-usage-problem.js';
import { printResult, printUsageError } from './print-result.js';

/** @typedef {import('./document-kinds.js').DocumentKind} DocumentKind */

const DOCUMENT_OPTIONS = Object.freeze({
  scenarios: { type: 'string' },
  out: { type: 'string' },
  check: { type: 'boolean' },
  config: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
});

/**
 * @typedef {object} DocumentValues The options of a command that writes a document.
 * @property {string} [scenarios]
 * @property {string} [out]
 * @property {boolean} [check]
 * @property {string} [config]
 * @property {boolean} [json]
 */

/**
 * Reads the arguments of `dwfb map` or `dwfb snapshot`, and prints the usage for --help and for each usage error.
 * @param {DocumentKind} kind
 * @param {string[]} args
 * @param {string} usage The help text of the command.
 * @returns {{ exitCode: number } | { exitCode: null, script: string | undefined, values: DocumentValues }} The exit
 *   code when the command printed its usage, else the script and the options.
 */
export function parseDocumentArgs(kind, args, usage) {
  let parsed = null;
  let problem = null;

  try {
    parsed = parseArgs({ args, options: DOCUMENT_OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    return { exitCode: printUsageError(kind.command, `${error.message}\n\n${usage}`) };
  }

  const { values, positionals } = parsed;
  if (values.help) return { exitCode: printResult(usage) };
  problem = findUsageProblem(kind, values, positionals);
  if (problem !== null) return { exitCode: printUsageError(kind.command, `${problem}.\n\n${usage}`) };

  return { exitCode: null, script: positionals[0], values };
}

/**
 * @param {DocumentKind} kind
 * @param {DocumentValues} values
 * @param {string[]} positionals
 * @returns {string | null} The usage error, with no full stop, or null for none.
 */
function findUsageProblem(kind, values, positionals) {
  const [script] = positionals;
  const scriptProblem = findScriptUsageProblem(values, positionals, kind.verb);

  if (scriptProblem !== null) return scriptProblem;
  if (values.out === '') return `Name the ${kind.name} file with --out <file>`;
  if (values.out !== undefined && isFolderPath(values.out)) return `The out path ${values.out} names a folder, so name a file with --out <file>`;
  if (script === undefined && values.out !== undefined) return `Name the script whose ${kind.name} --out writes`;
  return null;
}
