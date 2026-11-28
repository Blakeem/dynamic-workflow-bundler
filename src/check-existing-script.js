import { readFile, stat } from 'node:fs/promises';
import { isBuiltScript } from './is-built-script.js';
import { MISSING_FILE_CODES } from './load-sources.js';
import { READ_BYTE_LIMIT } from './read-byte-limit.js';
import { UsageError } from './usage-error.js';

/**
 * Throws a UsageError for an existing file at `out` that is no built script, so that a mistyped `out` cannot
 * replace a hand-written file.
 * @param {string} outFile The absolute path of `out`, which checkOutPath accepted.
 * @param {string} out The path as the caller gave it.
 * @param {boolean} banner Whether the build writes the banner line.
 */
export async function checkExistingScript(outFile, out, banner) {
  let outStats = null;

  try {
    outStats = await stat(outFile);
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) return;
    throw error;
  }
  // The build writes no script larger than READ_BYTE_LIMIT, so a larger file is no built script and is not read.
  if (outStats.size <= READ_BYTE_LIMIT && isBuiltScript((await readFile(outFile)).toString('utf8'), banner)) return;
  throw new UsageError(`The out file ${out} exists and is no script that dwfb build wrote ${banner ? 'with a banner' : 'with no banner'}, so remove the file or name another one`);
}
