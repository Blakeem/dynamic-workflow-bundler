import { realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
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
