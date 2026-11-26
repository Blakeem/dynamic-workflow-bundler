import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isFolderPath } from './display-path.js';
import { MISSING_FILE_CODES } from './load-sources.js';
import { READ_BYTE_LIMIT } from './read-byte-limit.js';
import { UsageError } from './usage-error.js';

/**
 * Reads a workflow script's bytes, and its size in bytes.
 * Gives null for the bytes of a file larger than READ_BYTE_LIMIT, which it does not read.
 * Rejects with a UsageError for a script that does not exist, that is not a file, or whose path ends in a
 * path separator or a `.` or `..` segment.
 * @param {string} script Relative to the working directory, or absolute.
 * @returns {Promise<{ size: number, bytes: Buffer | null }>}
 */
export async function readScript(script) {
  let scriptStats = null;
  let bytes = null;

  try {
    scriptStats = await stat(resolve(script));
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) throw new UsageError(`The script file ${script} does not exist`);
    throw error;
  }
  if (isFolderPath(script) || !scriptStats.isFile()) throw new UsageError(`The script ${script} is not a file`);
  if (scriptStats.size > READ_BYTE_LIMIT) return { size: scriptStats.size, bytes: null };

  bytes = await readFile(resolve(script));
  return { size: bytes.length, bytes };
}
