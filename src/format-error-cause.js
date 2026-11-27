import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDisplayPath } from './display-path.js';
import { findRealPath, formatRealDisplayPath } from './real-path.js';

// Command output holds no absolute path. Node's load errors quote a module path, end the importing file's path
// after "imported from" at a semicolon or the line's end, and leave other paths bare, which end at a space.
// On Windows a path may open with the \\?\ prefix, such as the package.json path of a module scope error, or
// with a UNC share, as \\server\share\ or \\?\UNC\server\share\ gives it, and a file URL may name a host.
const FILE_URL_ROOT = String.raw`file:\/\/[^\/\s'"]*\/`;
const DISK_ROOT = String.raw`(?:\\\\\?\\)?[A-Za-z]:\\|\\\\(?:\?\\UNC\\)?[^\\\s'"]+\\[^\\\s'"]+\\|\/`;
const ABSOLUTE_PATH_PATTERN = new RegExp([
  String.raw`(?<=(?<quote>['"]))(?:${FILE_URL_ROOT}|${DISK_ROOT})[^'"\n]+(?=\k<quote>)`,
  String.raw`(?<= imported from )(?:${FILE_URL_ROOT}|${DISK_ROOT})[^;\n]*`,
  String.raw`${FILE_URL_ROOT}[^\s'"]+`,
  String.raw`(?<![\w/\\.:])(?:${DISK_ROOT})[^\s'"]+`,
].join('|'), 'g');
const TRAILING_PUNCTUATION_PATTERN = /^(.*?)([.,;:)]*)$/s;
// Node quotes the pathname of a file URL for an invalid specifier, which on Windows puts a slash before the drive.
const URL_PATHNAME_DRIVE_PATTERN = /^\/[A-Za-z]:\//;
const WINDOWS_LONG_PATH_PREFIX = '\\\\?\\';
const WINDOWS_LONG_UNC_PREFIX = '\\\\?\\UNC\\';
const UNC_PREFIX = '\\\\';
const TEXTLESS_THROW_CAUSE = 'Its code threw a value that has no text';

/**
 * @param {unknown} error What the user's code threw or rejected with, such as the import of a config file.
 * @returns {Promise<string>} The error's message with no absolute path and no closing period, or a fixed cause
 *   for a value with no text.
 */
export async function formatErrorCause(error) {
  let message = '';
  let periodlessMessage = '';
  let displayTokens = [];
  let cause = '';

  try {
    message = String(error instanceof Error ? error.message : error);
  } catch {
    // String() throws for a value with no primitive form, such as Object.create(null).
    return TEXTLESS_THROW_CAUSE;
  }
  // The period goes before the paths are named, so a path named `.` at the message's end stays.
  periodlessMessage = message.replace(/\.$/, '');
  displayTokens = await Promise.all(Array.from(periodlessMessage.matchAll(ABSOLUTE_PATH_PATTERN), ([token]) => formatPathToken(token)));
  // replace visits the matches in the order matchAll gave them.
  cause = periodlessMessage.replace(ABSOLUTE_PATH_PATTERN, () => displayTokens.shift());

  return cause.trim() === '' ? TEXTLESS_THROW_CAUSE : cause;
}

/**
 * A token that is no path on disk stays as it is, since an error message the user's code throws, such as one
 * that quotes a regular expression, can hold text that looks like a path.
 * @param {string} token An absolute path or file URL, with any punctuation that follows it in the message.
 * @returns {Promise<string>} The real path relative to the real path of the working directory, since Node's
 *   message names real paths, else the path as formatDisplayPath gives it, with the punctuation kept.
 */
async function formatPathToken(token) {
  const [, pathText, punctuation] = /** @type {RegExpExecArray} */ (TRAILING_PUNCTUATION_PATTERN.exec(token));
  let file = pathText;
  let displayPath = '';

  if (pathText.startsWith('file:')) {
    try {
      file = fileURLToPath(pathText);
    } catch {
      return token;
    }
  }
  if (process.platform === 'win32' && URL_PATHNAME_DRIVE_PATTERN.test(pathText)) file = pathText.slice(1);
  if (file.startsWith(WINDOWS_LONG_UNC_PREFIX)) file = `${UNC_PREFIX}${file.slice(WINDOWS_LONG_UNC_PREFIX.length)}`;
  if (file.startsWith(WINDOWS_LONG_PATH_PREFIX)) file = file.slice(WINDOWS_LONG_PATH_PREFIX.length);
  if (!isPathOnDisk(file)) return token;
  try {
    // The last name resolves too, since a thrown message can name a link, such as the working directory's spelling.
    displayPath = await formatRealDisplayPath(await findRealPath(file));
  } catch {
    // A realpath error, such as for a link that loops, would hide the failure, so the path keeps its spelling.
    return `${formatDisplayPath(file)}${punctuation}`;
  }
  // A real path on another drive than the working directory has no relative form, so the path keeps its spelling.
  if (isAbsolute(displayPath)) return `${formatDisplayPath(file)}${punctuation}`;

  return `${displayPath}${punctuation}`;
}

/**
 * @param {string} file
 * @returns {boolean} True for a file that exists, or one that would sit under an existing folder other than
 *   a root, such as a missing module that Node names.
 */
function isPathOnDisk(file) {
  let folder = dirname(resolve(file));

  if (existsSync(file)) return true;
  while (dirname(folder) !== folder) {
    if (existsSync(folder)) return true;
    folder = dirname(folder);
  }

  return false;
}
