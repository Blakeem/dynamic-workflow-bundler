import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { compileScript } from './compile-script.js';
import { formatForwardSlashes } from './display-path.js';
import { findLineOrigin } from './expand-parts.js';
import { findDifferentLine } from './find-different-line.js';
import { joinModules } from './join-modules.js';
import { linkModules } from './link-modules.js';
import { loadSources, MISSING_FILE_CODES } from './load-sources.js';
import { findRealPath } from './real-path.js';
import { UsageError } from './usage-error.js';
import { writeScript } from './write-script.js';

/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./load-sources.js').LoadedSource} LoadedSource */

// A misspelled key such as `Write` would otherwise be dropped, and the build would write `out`.
const BUILD_OPTION_KEYS = new Set(['entry', 'out', 'banner', 'write', 'check']);

/**
 * @typedef {object} BuildOptions
 * @property {string} entry The entry file, relative to the working directory or absolute.
 * @property {string} out The built script's path. Required even with `write: false`, since the banner names
 *   the entry relative to it.
 * @property {boolean} [banner] Writes the banner line. Defaults to true.
 * @property {boolean} [write] Writes the built script. Defaults to true, and to false with `check`.
 * @property {boolean} [check] Writes nothing, and compares the built script with the file at `out`.
 *   Defaults to false.
 */

/**
 * @typedef {object} FirstDifference
 * @property {number} line The 1-based line of the built script where the file at `out` first differs.
 * @property {string | null} file The source that the line comes from, as LineOrigin gives it.
 * @property {number | null} sourceLine The source's line, or null for a line the build adds.
 */

/**
 * @typedef {object} BuildResult
 * @property {boolean} ok True when the build found nothing.
 * @property {'written' | 'built' | 'fresh' | 'stale' | 'missing' | 'failed'} status `failed` when the build
 *   has a finding. Otherwise `written`, `built` with `write: false`, or with `check` one of `fresh` (the file
 *   at `out` is the built script), `stale` (it differs) or `missing` (no file is there).
 * @property {string | null} script The built script, or null when the build has a finding.
 * @property {string[]} sources Every source file read, once each: the entry, its parts in directive order,
 *   then each module, text file and JSON file in the order its first import reached it.
 * @property {Finding[]} findings
 * @property {FirstDifference} [firstDifference] Present when `status` is `stale`.
 * Every path is relative to the real path of the working directory, with forward slashes.
 */

/**
 * Builds one workflow script from an entry, its parts, and the modules, text files and JSON files it
 * imports. Prints nothing.
 * Rejects with a UsageError for options that are not an object, an unknown or wrong option, `check` with
 * `write: true`, a missing entry, an `out` that names a source, a folder or a path inside a file, and an
 * `out` on another drive than the entry when the banner is on.
 * @param {BuildOptions} options
 * @returns {Promise<BuildResult>}
 */
export async function build(options = /** @type {BuildOptions} */ ({})) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new UsageError('build() takes an options object');
  const unknownKey = Object.keys(options).find((key) => !BUILD_OPTION_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`build() takes no option ${unknownKey}`);
  const { entry, out, banner = true, check = false } = options;
  const { write = !check } = options;
  if (typeof entry !== 'string' || entry === '') throw new UsageError('build() needs entry, the path of an entry file');
  if (typeof out !== 'string' || out === '') throw new UsageError('build() needs out, the path of the built script');
  if (typeof banner !== 'boolean') throw new UsageError('build() takes banner as a boolean');
  if (typeof write !== 'boolean') throw new UsageError('build() takes write as a boolean');
  if (typeof check !== 'boolean') throw new UsageError('build() takes check as a boolean');
  if (check && write) throw new UsageError('build() writes nothing with check, so it takes no write: true');

  const entryFile = await findEntryFile(entry);
  const outFile = resolve(out);
  // Source files are real paths, so each path they are reported against is a real path too.
  const workFolder = await realpath(process.cwd());
  const formatSourcePath = (file) => formatForwardSlashes(relative(workFolder, file));
  const { sources, parts, findings: loadFindings } = await loadSources(resolve(entry), banner);
  const [, ...importedFiles] = sources.keys();
  const sourceFiles = [...new Set([entryFile, ...parts, ...importedFiles])];
  await checkOutFile(outFile, out, sourceFiles);
  const bannerPath = banner ? formatForwardSlashes(relative(await findRealPath(dirname(outFile)), entryFile)) : null;
  if (bannerPath !== null && isAbsolute(bannerPath)) {
    throw new UsageError(`The out file ${out} is on another drive than the entry, so the banner cannot name the entry by a relative path`);
  }
  const { order, findings: linkFindings } = linkModules(sources, entryFile, formatSourcePath);

  const entrySource = /** @type {LoadedSource} */ (sources.get(entryFile));
  const sourcePaths = sourceFiles.map(formatSourcePath);
  const placedFindings = [...loadFindings, ...linkFindings].map((finding) => placeEntryFinding(finding, entrySource));
  const findings = sortFindings(placedFindings, sourceFiles).map((finding) => ({
    ...finding,
    file: formatSourcePath(finding.file),
  }));
  if (findings.length > 0) return { ok: false, status: 'failed', script: null, sources: sourcePaths, findings };

  const entryFolder = dirname(entryFile);
  const joinedSources = order.map((file) => ({ ...sources.get(file), path: formatForwardSlashes(relative(entryFolder, file)) }));
  const { script, lineOrigins } = joinModules({ entry: entrySource, sources: joinedSources, bannerPath });

  compileBuiltScript(script, entrySource.analysis.metaEnd);
  if (check) {
    const comparison = await compareOutFile(outFile, script, lineOrigins, formatSourcePath);
    return { ok: true, ...comparison, script, sources: sourcePaths, findings: [] };
  }
  if (write) await writeScript(outFile, script);

  return { ok: true, status: write ? 'written' : 'built', script, sources: sourcePaths, findings: [] };
}

/**
 * @param {string} outFile
 * @param {string} script
 * @param {import('./join-modules.js').LineOrigin[]} lineOrigins
 * @param {(file: string) => string} formatSourcePath
 * @returns {Promise<{ status: 'fresh' | 'stale' | 'missing', firstDifference?: FirstDifference }>}
 */
async function compareOutFile(outFile, script, lineOrigins, formatSourcePath) {
  let diskBytes = null;

  try {
    diskBytes = await readFile(outFile);
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) return { status: 'missing' };
    throw error;
  }
  const line = findDifferentLine(Buffer.from(script, 'utf8'), diskBytes);
  if (line === null) return { status: 'fresh' };
  const origin = lineOrigins[line - 1];

  return {
    status: 'stale',
    firstDifference: { line, file: origin.file === null ? null : formatSourcePath(origin.file), sourceLine: origin.line },
  };
}

/**
 * Every source of the script passed its checks, so a built script that does not compile is a defect of
 * this tool, not of a source.
 * @param {string} script
 * @param {number} metaEnd The offset just after the meta statement.
 */
export function compileBuiltScript(script, metaEnd) {
  try {
    compileScript(script, metaEnd);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`The built script does not compile, which is a defect in dynamic-workflow-bundler. ${error.message}`, { cause: error });
  }
}

/**
 * @param {string} entry
 * @returns {Promise<string>} The entry's real path.
 */
async function findEntryFile(entry) {
  let entryFile = '';

  try {
    entryFile = await realpath(resolve(entry));
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) throw new UsageError(`The entry file ${entry} does not exist`);
    throw error;
  }
  if (!(await stat(entryFile)).isFile()) throw new UsageError(`The entry ${entry} is not a file`);

  return entryFile;
}

/**
 * @param {string} outFile
 * @param {string} out The path as the caller gave it.
 * @param {string[]} sourceFiles The real path of every source.
 */
async function checkOutFile(outFile, out, sourceFiles) {
  let outRealFile = null;

  try {
    outRealFile = await realpath(outFile);
  } catch (error) {
    if (!MISSING_FILE_CODES.has(error.code)) throw error;
    await checkOutFolder(outFile, out);
    return;
  }
  if (sourceFiles.includes(outRealFile)) throw new UsageError(`The out file ${out} is a source of this build`);
  if (!(await stat(outRealFile)).isFile()) throw new UsageError(`The out path ${out} is not a file`);
}

/**
 * Checks that the nearest existing folder above a missing `out` is a folder, which the build can create
 * the rest of the path in.
 * @param {string} outFile
 * @param {string} out The path as the caller gave it.
 */
async function checkOutFolder(outFile, out) {
  let folder = dirname(outFile);
  let folderStats = await statIfExists(folder);

  while (folderStats === null && dirname(folder) !== folder) {
    folder = dirname(folder);
    folderStats = await statIfExists(folder);
  }
  if (folderStats !== null && !folderStats.isDirectory()) throw new UsageError(`The out path ${out} is inside a file`);
}

/**
 * @param {string} path
 * @returns {Promise<import('node:fs').Stats | null>} Null when no file or folder exists at the path.
 */
async function statIfExists(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) return null;
    throw error;
  }
}

/**
 * A finding on the entry is placed in the entry's text with each part in place of its directive, so a
 * finding on a part's line names the part and its own line.
 * @param {Finding} finding
 * @param {LoadedSource} entrySource
 * @returns {Finding}
 */
function placeEntryFinding(finding, entrySource) {
  if (finding.file !== entrySource.file) return finding;
  const origin = findLineOrigin(entrySource.includes, finding.line);
  return { ...finding, file: origin.file ?? entrySource.file, line: origin.line };
}

/**
 * @param {Finding[]} findings
 * @param {string[]} sourceFiles In read order.
 * @returns {Finding[]} Ordered by source file, then line, then column.
 */
function sortFindings(findings, sourceFiles) {
  const findSourceIndex = (file) => sourceFiles.indexOf(file);
  return [...findings].sort(
    (first, second) => findSourceIndex(first.file) - findSourceIndex(second.file) || first.line - second.line || first.column - second.column,
  );
}
