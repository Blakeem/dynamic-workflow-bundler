import { relative, resolve, sep } from 'node:path';

/**
 * @param {string} path
 * @returns {string}
 */
export function formatForwardSlashes(path) {
  return path.split(sep).join('/');
}

/**
 * Gives a path relative to the working directory as `process.cwd()` names it, with forward slashes.
 * A build reports source and finding paths relative to the working directory's real path, which differs
 * when the working directory is reached through a link.
 * @param {string} path Absolute, or relative to the working directory.
 * @returns {string}
 */
export function formatDisplayPath(path) {
  return formatForwardSlashes(relative(process.cwd(), resolve(path)));
}

/**
 * Gives a path to pass on as an option, such as build()'s entry, so that a message names no absolute path.
 * @param {string} path Absolute, or relative to the working directory.
 * @returns {string} formatDisplayPath's path, or `.` for the working directory, since an option reads ''
 *   as a missing path.
 */
export function formatOptionPath(path) {
  return formatDisplayPath(path) || '.';
}
