import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { findBanner } from './banner.js';
import { buildMappedScript } from './build.js';
import { formatBuildCommand } from './build-command.js';
import { convertRuntimePosition } from './convert-runtime-position.js';
import { formatDisplayPath, formatForwardSlashes, formatOptionPath } from './display-path.js';
import { findConfigWorkflows } from './find-config-workflows.js';
import { CONFIG_FILE, loadConfig } from './load-config.js';
import { MISSING_FILE_CODES } from './load-sources.js';
import { findRealPath } from './real-path.js';
import { countLines } from './source-position.js';
import { UsageError } from './usage-error.js';

/** @typedef {import('./finding.js').Finding} Finding */

/**
 * @typedef {object} ScriptWorkflow The workflow a built script comes from.
 * @property {string} entry
 * @property {boolean} banner Whether the build that rewrites the script writes the banner.
 */

// A misspelled key such as `Entry` would otherwise be dropped, and the entry found another way.
const LOCATE_OPTION_KEYS = new Set(['script', 'line', 'column', 'runtime', 'entry', 'config']);

/**
 * @typedef {object} LocateOptions
 * @property {string} script The built script, relative to the working directory or absolute.
 * @property {number} line The script's 1-based line, or with `runtime` the runtime's.
 * @property {number} [column] The 1-based column on that line. Defaults to 1.
 * @property {boolean} [runtime] Reads `line` and `column` as the runtime numbers them in a stack trace.
 *   Defaults to false.
 * @property {string} [entry] The entry the script is built from. Wins over the banner and the config file.
 * @property {string} [config] The config file whose workflow with this `out` names the entry of a script with
 *   no banner. Defaults to dwfb.config.js in the working directory.
 */

/**
 * @typedef {object} LocateResult
 * @property {boolean} ok False when a source has a finding or the script differs from the script the build
 *   gives. Every field but `findings` is then null or false.
 * @property {string | null} file The source file. For a line the build adds, the source whose constant, scope
 *   or imported names the line holds, or null for a line of no source, such as the banner.
 * @property {number | null} line The source's 1-based line, or null for a line the build adds.
 * @property {number | null} column The source's 1-based column, or null for a line the build adds.
 * @property {string | null} text The source line, or null for a line the build adds.
 * @property {boolean} generated True for a line the build adds.
 * @property {Finding[]} findings
 * Every path is relative to the real path of the working directory, with forward slashes, as a build gives it.
 */

/**
 * Maps a line of a built script to its source file, line and column. Builds the script in memory from its
 * entry, and writes and prints nothing.
 * Rejects with a UsageError for options of another shape, a script that does not exist, a line or column
 * that is not a whole number of 1 or more or lies past the script's text, with `runtime` a line that the
 * runtime's numbering cannot convert, an entry it cannot find, and every usage error of the build.
 * @param {LocateOptions} options
 * @returns {Promise<LocateResult>}
 */
export async function locate(options = /** @type {LocateOptions} */ ({})) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new UsageError('locate() takes an options object');
  const unknownKey = Object.keys(options).find((key) => !LOCATE_OPTION_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`locate() takes no option ${unknownKey}`);
  const { script, line, column = 1, runtime = false, entry, config } = options;
  if (typeof script !== 'string' || script === '') throw new UsageError('locate() needs script, the path of a built script');
  if (typeof line !== 'number') throw new UsageError('locate() needs line as a number');
  if (typeof column !== 'number') throw new UsageError('locate() takes column as a number');
  if (!isCount(line)) throw new UsageError(`The line ${line} is not a whole number of 1 or more`);
  if (!isCount(column)) throw new UsageError(`The column ${column} is not a whole number of 1 or more`);
  if (typeof runtime !== 'boolean') throw new UsageError('locate() takes runtime as a boolean');
  if (entry !== undefined && (typeof entry !== 'string' || entry === '')) throw new UsageError('locate() takes entry as the path of an entry file');
  if (config !== undefined && (typeof config !== 'string' || config === '')) throw new UsageError('locate() takes config as the path of a config file');

  const scriptText = await readScript(script);
  const banner = findBanner(scriptText);
  const scriptWorkflow = entry === undefined ? await findScriptWorkflow(script, banner, config) : { entry, banner: banner.hasSyntaxError || banner.path !== null };
  // A script that does not parse differs from every build, so the in-memory build takes its workflow's banner.
  const hasBanner = banner.hasSyntaxError ? scriptWorkflow.banner : banner.path !== null;
  const { result, findSourcePosition, metaEnd } = await buildMappedScript({ entry: scriptWorkflow.entry, out: script, banner: hasBanner, check: true });
  if (result.status === 'failed') return createFailedResult(result.findings);
  if (result.status === 'missing') throw new UsageError(`The script file ${script} does not exist`);
  if (result.status === 'stale') return createFailedResult([await createStaleFinding(script, result.firstDifference.line, scriptWorkflow)]);
  const position = runtime ? convertRuntimePosition(scriptText, /** @type {number} */ (metaEnd), line, column) : { line, column };
  checkScriptPosition(scriptText, script, position, runtime ? { line, column } : null);
  const source = /** @type {NonNullable<typeof findSourcePosition>} */ (findSourcePosition)(position.line, position.column);

  return { ok: true, ...source, generated: source.line === null, findings: [] };
}

/**
 * @param {number} value
 * @returns {boolean} True for a whole number of 1 or more.
 */
function isCount(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * @param {string} script
 * @returns {Promise<string>}
 */
async function readScript(script) {
  let scriptStats = null;

  try {
    scriptStats = await stat(resolve(script));
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) throw new UsageError(`The script file ${script} does not exist`);
    throw error;
  }
  if (!scriptStats.isFile()) throw new UsageError(`The script ${script} is not a file`);

  return readFile(resolve(script), 'utf8');
}

/**
 * @param {string} script
 * @param {{ path: string | null, hasSyntaxError: boolean }} banner The script's banner, as findBanner gives it.
 * @param {string | undefined} config
 * @returns {Promise<ScriptWorkflow>} The entry, as formatOptionPath gives it, and the banner of the config
 *   file's workflow, or true for an entry the banner names.
 */
async function findScriptWorkflow(script, banner, config) {
  const configPath = config ?? CONFIG_FILE;
  const noBannerReason = banner.hasSyntaxError ? 'does not parse' : 'has no banner';

  if (banner.path !== null) {
    // The build gives the banner path relative to the real path of the script's folder.
    const bannerEntry = resolve(await findRealPath(dirname(resolve(script))), banner.path);
    if (!existsSync(bannerEntry)) {
      throw new UsageError(`The banner of the script ${script} names the entry ${formatDisplayPath(bannerEntry)}, which does not exist, so name the entry it is built from with --entry <file>`);
    }
    return { entry: formatOptionPath(bannerEntry), banner: true };
  }
  if (config === undefined && !existsSync(CONFIG_FILE)) {
    throw new UsageError(`The script ${script} ${noBannerReason}, and no config file ${CONFIG_FILE} exists here, so name the entry it is built from with --entry <file>`);
  }
  const { workflows } = await loadConfig(configPath);
  const [scriptWorkflow] = await findConfigWorkflows(workflows, 'out', script);
  if (scriptWorkflow !== undefined) return { entry: formatOptionPath(scriptWorkflow.entry), banner: scriptWorkflow.banner };

  throw new UsageError(`The script ${script} ${noBannerReason}, and the config file ${configPath} has no workflow whose out is the script, so name the entry it is built from with --entry <file>`);
}

/**
 * @param {string} scriptText
 * @param {string} script
 * @param {{ line: number, column: number }} position
 * @param {{ line: number, column: number } | null} runtimePosition The line and column the caller gave with
 *   `runtime`, which the messages name.
 */
function checkScriptPosition(scriptText, script, { line, column }, runtimePosition) {
  const lines = scriptText.split('\n');
  const lastLine = countLines(scriptText);
  const lineLabel = runtimePosition === null ? `line ${line}` : `the runtime line ${runtimePosition.line}, which is line ${line},`;
  const columnLabel = runtimePosition === null ? `Column ${column}` : `The runtime column ${runtimePosition.column}, which is column ${column},`;

  if (line > lastLine) throw new UsageError(`The script ${script} ends on line ${lastLine}, so ${lineLabel} is past its end`);
  const lineLength = lines[line - 1].length;
  if (column > lineLength + 1) throw new UsageError(`${columnLabel} is past the end of ${lineLabel} of the script ${script}, which ends at column ${lineLength + 1}`);
}

/**
 * @param {Finding[]} findings
 * @returns {LocateResult}
 */
function createFailedResult(findings) {
  return { ok: false, file: null, line: null, column: null, text: null, generated: false, findings };
}

/**
 * @param {string} script
 * @param {number} line The script's first line that differs from the script the build gives.
 * @param {ScriptWorkflow} scriptWorkflow
 * @returns {Promise<Finding>} The finding, whose fix names the command that rewrites the script as its
 *   workflow gives it.
 */
async function createStaleFinding(script, line, scriptWorkflow) {
  const buildCommand = formatBuildCommand(scriptWorkflow.entry, { out: script, 'no-banner': !scriptWorkflow.banner });
  // A build gives every path relative to the real path of the working directory.
  const scriptPath = formatForwardSlashes(relative(await realpath(process.cwd()), await findRealPath(script)));

  return {
    rule: 'script-stale',
    message: 'The script differs from the script the build gives',
    fix: `Run ${buildCommand}, since the line numbers may not match the source`,
    file: scriptPath,
    line,
    column: 1,
  };
}
