import { checkContract, checkScriptSize } from './check-contract.js';
import { CONTRACT_RUNTIME_VERSION } from './contract.js';
import { isObject } from './is-object.js';
import { readScript } from './read-script.js';
import { formatRealDisplayPath } from './real-path.js';
import { UsageError } from './usage-error.js';

/** @typedef {import('./finding.js').Finding} Finding */

// A misspelled key such as `Script` would otherwise read as a missing script.
const VALIDATE_OPTION_KEYS = new Set(['script']);

/**
 * @typedef {object} ValidateOptions
 * @property {string} script The workflow script, relative to the working directory or absolute.
 */

/**
 * @typedef {object} ValidateResult
 * @property {boolean} ok True when the script breaks no rule of the contract.
 * @property {string} script The script, relative to the real path of the working directory, with forward
 *   slashes, as `dwfb build` names each out.
 * @property {string} runtime The Claude Code version the contract was measured on.
 * @property {Finding[]} findings Sorted by line, then column. Each finding's `file` is `script`.
 */

/**
 * Checks a workflow script file against the contract of the runtime, and writes and prints nothing.
 * A file larger than READ_BYTE_LIMIT gets the script-too-large finding alone, since a parse of a file
 * that large may exhaust Node's memory.
 * Rejects with a UsageError for options of another shape, and for a script that does not exist, that is not a
 * file, or whose path ends in a path separator or a `.` or `..` segment.
 * @param {ValidateOptions} options
 * @returns {Promise<ValidateResult>}
 */
export async function validate(options = /** @type {ValidateOptions} */ ({})) {
  if (!isObject(options)) throw new UsageError('validate() takes an options object');
  const unknownKey = Object.keys(options).find((key) => !VALIDATE_OPTION_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`validate() takes no option ${unknownKey}`);
  const { script } = options;
  if (typeof script !== 'string' || script === '') throw new UsageError('validate() needs script, the path of a workflow script');

  const { scriptPath, findings } = await checkScriptFile(script);

  return { ok: findings.length === 0, script: scriptPath, runtime: CONTRACT_RUNTIME_VERSION, findings };
}

/**
 * Reads a workflow script file and checks it against the contract, as validate() does.
 * @param {string} script A path that is not empty, as ValidateOptions holds it.
 * @returns {Promise<{ scriptPath: string, text: string | null, findings: Finding[] }>} `scriptPath` as
 *   ValidateResult names it. `text` is null for a file larger than READ_BYTE_LIMIT.
 */
export async function checkScriptFile(script) {
  const { size, bytes } = await readScript(script);
  const scriptPath = await formatRealDisplayPath(script);
  // The runtime of Claude Code 2.1.332 decodes the file with toString('utf-8'), which reads a byte sequence that
  // is not valid UTF-8 as U+FFFD.
  const text = bytes === null ? null : bytes.toString('utf8');
  const findings = text === null ? checkScriptSize(size, scriptPath) : checkContract(text, scriptPath, size);

  return { scriptPath, text, findings };
}
