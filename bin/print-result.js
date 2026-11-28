import { formatDisplayPath } from '../src/display-path.js';
import { formatRealDisplayPath } from '../src/real-path.js';
import { UsageError } from '../src/usage-error.js';

export const EXIT_SUCCESS = 0;
export const EXIT_FINDINGS = 1;
const EXIT_FAILURE = 2;

/**
 * @param {string} text
 * @param {number} [exitCode]
 * @returns {number}
 */
export function printResult(text, exitCode = EXIT_SUCCESS) {
  process.stdout.write(text);
  return exitCode;
}

/**
 * @param {string} label
 * @param {string} text
 * @returns {number}
 */
export function printUsageError(label, text) {
  process.stderr.write(`${label}: ${text}`);
  return EXIT_FAILURE;
}

/**
 * @param {string} label The command, such as `dwfb build`.
 * @param {unknown} error
 * @param {string} [note] A sentence that follows the failure line's own, with its leading space.
 * @returns {Promise<number>}
 */
export async function printCommandFailure(label, error, note = '') {
  if (error instanceof UsageError) return printUsageError(label, `${error.message}.${note}\n`);
  if (isFileSystemError(error)) {
    process.stderr.write(`${label}: Could not read or write ${await formatFailedPath(error.path)} (${error.syscall} ${error.code}).${note}\n`);
    return EXIT_FAILURE;
  }
  process.stderr.write(`${label}: internal failure.${note}\n${error.stack ?? error}\n`);
  return EXIT_FAILURE;
}

/**
 * @param {string[]} writtenFiles Each file written before a failure, in write order.
 * @returns {Promise<string>} The sentence that names each file, or '' when none was written.
 */
export async function formatWrittenNote(writtenFiles) {
  const writtenPaths = [];
  for (const file of writtenFiles) writtenPaths.push(await formatFailedPath(file));
  return writtenPaths.length === 0 ? '' : ` Wrote ${writtenPaths.join(', ')} before the failure.`;
}

/**
 * @param {string} path The path a file system call failed on.
 * @returns {Promise<string>} The path as formatRealDisplayPath gives it, or as formatDisplayPath gives it when
 *   the folders above it cannot be read, since that error would hide the failure the message reports.
 */
async function formatFailedPath(path) {
  try {
    return await formatRealDisplayPath(path);
  } catch {
    return formatDisplayPath(path);
  }
}

/**
 * @param {unknown} error
 * @returns {error is NodeJS.ErrnoException & { path: string, syscall: string }} True for a
 *   failed file system call, which names the path it failed on.
 */
function isFileSystemError(error) {
  return error instanceof Error && typeof error.code === 'string' && typeof error.path === 'string' && typeof error.syscall === 'string';
}
