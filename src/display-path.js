import { relative, resolve, sep } from 'node:path';

const FOLDER_SEGMENTS = new Set(['', '.', '..']);

/**
 * @param {string} path
 * @returns {string}
 */
export function formatForwardSlashes(path) {
  return path.split(sep).join('/');
}

/**
 * @param {string} path
 * @returns {boolean} True for a path whose segment after its last `/` or platform separator is empty, `.` or
 *   `..`, which names a folder, although `resolve` drops or folds that segment. False for a bare `.` or `..`,
 *   which resolves to a folder that exists.
 */
export function isFolderPath(path) {
  const forwardPath = formatForwardSlashes(path);
  const lastSeparator = forwardPath.lastIndexOf('/');

  return lastSeparator !== -1 && FOLDER_SEGMENTS.has(forwardPath.slice(lastSeparator + 1));
}

/**
 * Gives a path relative to the working directory as `process.cwd()` names it, with forward slashes, so the
 * path resolves again from the working directory. A command's result names each path relative to the
 * working directory's real path, as a build gives each source, which differs when the working directory is
 * reached through a link.
 * @param {string} path Absolute, or relative to the working directory.
 * @returns {string} `.` for the working directory, since a message would name nothing and an option such as
 *   build()'s entry reads '' as a missing path.
 */
export function formatDisplayPath(path) {
  return formatForwardSlashes(relative(process.cwd(), resolve(path))) || '.';
}
