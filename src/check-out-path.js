import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MISSING_FILE_CODES } from './load-sources.js';
import { UsageError } from './usage-error.js';

/**
 * Throws a UsageError for a path that a command writes a file to and that names something other than a file, or
 * that is inside a file, so the command can refuse it before its first write.
 * @param {string} outFile An absolute path.
 * @param {string} pathLabel The path as the user gave it, after a noun, such as `The out path dist/a.js`.
 */
export async function checkOutPath(outFile, pathLabel) {
  // The user wrote the path, as the out of a build or the document file of dwfb map or dwfb snapshot. These stat checks hold on every platform.
  let folder = dirname(outFile);
  const outStats = await statIfExists(outFile);
  let folderStats = null;

  if (outStats !== null) {
    if (!outStats.isFile()) throw new UsageError(`${pathLabel} is not a file`);
    return;
  }
  // The write creates the missing folders above the file, which needs the nearest existing one to be a folder.
  folderStats = await statIfExists(folder);
  while (folderStats === null && dirname(folder) !== folder) {
    folder = dirname(folder);
    folderStats = await statIfExists(folder);
  }
  if (folderStats !== null && !folderStats.isDirectory()) throw new UsageError(`${pathLabel} is inside a file`);
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
