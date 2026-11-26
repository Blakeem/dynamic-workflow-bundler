import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { formatDisplayPath, formatForwardSlashes } from './display-path.js';
import { MISSING_FILE_CODES } from './load-sources.js';

/**
 * Gives one name to every spelling of a path, such as through a link or in another letter case on Windows.
 * The part of the path that does not exist yet keeps the spelling it was given.
 * @param {string} path A path that may not exist yet. Relative paths resolve against the working directory.
 * @returns {Promise<string>} The real path of its nearest existing file or folder, joined with the rest of the path.
 */
export async function findRealPath(path) {
  const absolutePath = resolve(path);
  let existingPath = absolutePath;
  let realPath = null;

  while (realPath === null) {
    try {
      realPath = await realpath(existingPath);
    } catch (error) {
      if (!MISSING_FILE_CODES.has(error.code) || dirname(existingPath) === existingPath) throw error;
      existingPath = dirname(existingPath);
    }
  }

  return join(realPath, relative(existingPath, absolutePath));
}

/**
 * Gives a path relative to the real path of the working directory, with forward slashes, as a build gives
 * each source. The last name keeps its spelling, since a write replaces a link at the path and leaves its target.
 * @param {string} path A path that may not exist yet. Relative paths resolve against the working directory.
 * @returns {Promise<string>} `.` for the real path of the working directory. A path whose real folder is on
 *   another drive than the working directory gets the form formatDisplayPath gives, since no relative path
 *   reaches that drive.
 */
export async function formatRealDisplayPath(path) {
  const absolutePath = resolve(path);
  const workFolder = await realpath(process.cwd());
  const realFolder = await findRealPath(dirname(absolutePath));
  const realRelativePath = relative(workFolder, join(realFolder, basename(absolutePath)));

  if (isAbsolute(realRelativePath)) return formatDisplayPath(path);

  return formatForwardSlashes(realRelativePath) || '.';
}
