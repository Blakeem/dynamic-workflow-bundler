import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkConfig } from './check-config.js';
import { checkModuleSyntax, hasModuleSyntax } from './check-module-syntax.js';
import { formatDisplayPath } from './display-path.js';
import { MISSING_FILE_CODES } from './load-sources.js';
import { normalizeSourceText } from './normalize-source-text.js';
import { UsageError } from './usage-error.js';

/** @typedef {import('./check-config.js').Config} Config */

/** The config file that a command reads from the working directory when no `--config` names another. */
export const CONFIG_FILE = 'dwfb.config.js';

// Command output holds no absolute path. Node's load errors quote a module path, end the importing file's path
// after "imported from" at a semicolon or the line's end, and leave other paths bare, which end at a space.
// On Windows a path may open with the \\?\ prefix, such as the package.json path of a module scope error.
const ABSOLUTE_PATH_PATTERN = /(?<=(?<quote>['"]))(?:file:\/\/\/|(?:\\\\\?\\)?[A-Za-z]:\\|\/)[^'"\n]+(?=\k<quote>)|(?<= imported from )(?:file:\/\/\/|(?:\\\\\?\\)?[A-Za-z]:\\|\/)[^;\n]*|file:\/\/\/[^\s'"]+|(?<![\w/\\.:])(?:(?:\\\\\?\\)?[A-Za-z]:\\|\/)[^\s'"]+/g;
const TRAILING_PUNCTUATION_PATTERN = /^(.*?)([.,;:)]*)$/s;
// Node quotes the pathname of a file URL for an invalid specifier, which on Windows puts a slash before the drive.
const URL_PATHNAME_DRIVE_PATTERN = /^\/[A-Za-z]:\//;
const WINDOWS_LONG_PATH_PREFIX = '\\\\?\\';
const [NODE_MAJOR_VERSION, NODE_MINOR_VERSION] = process.versions.node.split('.').map(Number);
// Node.js 22.7.0 unflagged syntax detection, which loads a .js file of a package with no "type" as an ES
// module when the file holds module syntax.
export const IS_MODULE_SYNTAX_DETECTED = NODE_MAJOR_VERSION > 22 || (NODE_MAJOR_VERSION === 22 && NODE_MINOR_VERSION >= 7);

/**
 * Loads a config file as an ES module and checks its default export. Node keeps each module it loads, so
 * a later call in the same process reads the file as the first call loaded it.
 * Rejects with a UsageError for a path that is not a string, a missing file, a folder, a file that fails
 * to load, and every problem that checkConfig names.
 * @param {string} path The config file, relative to the working directory or absolute.
 * @returns {Promise<Config>} Every path absolute.
 */
export async function loadConfig(path) {
  let configStats = null;
  let configModule = null;

  if (typeof path !== 'string' || path === '') throw new UsageError('loadConfig() needs path, the path of a config file');
  const configFile = resolve(path);
  try {
    configStats = await stat(configFile);
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) throw new UsageError(`The config file ${path} does not exist`);
    throw error;
  }
  if (!configStats.isFile()) throw new UsageError(`The config file ${path} is not a file`);
  try {
    configModule = await import(pathToFileURL(configFile).href);
  } catch (error) {
    throw new UsageError(await formatLoadFailure(error, configFile, path));
  }

  return checkConfig(configModule.default, configFile, path);
}

/**
 * @param {unknown} error What the import rejected with.
 * @param {string} configFile
 * @param {string} path The config file's path as the caller gave it.
 * @returns {Promise<string>}
 */
async function formatLoadFailure(error, configFile, path) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = message.replace(ABSOLUTE_PATH_PATTERN, formatPathToken).replace(/\.$/, '');
  const isSyntaxError = error instanceof SyntaxError;
  const isEsModule = isSyntaxError ? await isEsModuleFile(configFile) : true;
  const parseFailure = isSyntaxError ? await findParseFailure(configFile, isEsModule) : null;

  if (parseFailure !== null) {
    return `The config file ${path} does not load. ${parseFailure.file}:${parseFailure.line}:${parseFailure.column} ${parseFailure.reason}`;
  }
  // Node loaded the config file as CommonJS, where an `import` or `export` statement is a syntax error.
  if (!isEsModule) {
    return `The config file ${path} does not load. ${cause}. If the file is an ES module, set "type": "module" in the nearest package.json, or name a .mjs config file with --config`;
  }

  return `The config file ${path} does not load. ${cause}`;
}

/**
 * Finds the file of a config file's static imports that does not parse, since Node's syntax error names no
 * file and no line (Node.js 24.22.1). A syntax error that the config file throws as it runs, such as from
 * JSON.parse, gives null.
 * Node compiles the files depth first in source order and stops at the first that fails, so the search
 * takes that order and reads only files that Node read.
 * @param {string} configFile
 * @param {boolean} isImportFollowed False for a config file that loads as CommonJS, which loads no ES import.
 * @returns {Promise<{ file: string, line: number, column: number, reason: string } | null>} The file relative
 *   to the working directory.
 */
async function findParseFailure(configFile, isImportFollowed) {
  const pendingFiles = [configFile];
  const seenFiles = new Set();

  while (pendingFiles.length > 0) {
    const file = /** @type {string} */ (pendingFiles.pop());
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const text = normalizeSourceText(await readFile(file, 'utf8'));
    const { syntaxError, importSpecifiers } = checkModuleSyntax(text, file);
    if (syntaxError !== null) return { file: formatDisplayPath(file), ...syntaxError };
    if (!isImportFollowed) return null;
    const importedFiles = importSpecifiers.map((specifier) => findImportedFile(specifier, file)).filter((importedFile) => importedFile !== null);
    pendingFiles.push(...importedFiles.reverse());
  }

  return null;
}

/**
 * @param {string} specifier A relative specifier.
 * @param {string} importingFile
 * @returns {string | null} Null for a specifier that names no file path, such as one with an encoded slash or
 *   NUL, which Node refuses before it reads a file.
 */
function findImportedFile(specifier, importingFile) {
  let file = '';

  try {
    file = fileURLToPath(new URL(specifier, pathToFileURL(importingFile)));
  } catch (error) {
    // fileURLToPath throws a URIError for a malformed percent escape, such as the one in './100%.js'.
    if (error instanceof URIError || error.code === 'ERR_INVALID_FILE_URL_PATH') return null;
    throw error;
  }

  return file.includes('\0') ? null : file;
}

/**
 * A token that is no path on disk stays as it is, since an error message the config file throws, such as one
 * that quotes a regular expression, can hold text that looks like a path.
 * @param {string} token An absolute path or file URL, with any punctuation that follows it in the message.
 * @returns {string} The path relative to the working directory, with the punctuation kept.
 */
function formatPathToken(token) {
  const [, pathText, punctuation] = /** @type {RegExpExecArray} */ (TRAILING_PUNCTUATION_PATTERN.exec(token));
  let file = pathText;

  if (pathText.startsWith('file:')) {
    try {
      file = fileURLToPath(pathText);
    } catch {
      return token;
    }
  }
  if (process.platform === 'win32' && URL_PATHNAME_DRIVE_PATTERN.test(pathText)) file = pathText.slice(1);
  if (file.startsWith(WINDOWS_LONG_PATH_PREFIX)) file = file.slice(WINDOWS_LONG_PATH_PREFIX.length);
  if (!isPathOnDisk(file)) return token;

  return `${formatDisplayPath(file) || '.'}${punctuation}`;
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

/**
 * @param {string} configFile
 * @returns {Promise<boolean>} True for a file that Node loads as an ES module: a `.mjs` file, a `.js` file
 *   whose nearest package.json sets `"type": "module"`, or one of a package with no "type" that holds
 *   module syntax.
 */
async function isEsModuleFile(configFile) {
  const extension = extname(configFile);
  let packageType = null;

  if (extension === '.mjs') return true;
  if (extension === '.cjs') return false;
  packageType = await findPackageType(dirname(configFile));
  if (packageType !== null) return packageType === 'module';
  if (!IS_MODULE_SYNTAX_DETECTED) return false;

  return hasModuleSyntax(normalizeSourceText(await readFile(configFile, 'utf8')));
}

/**
 * @param {string} folder
 * @returns {Promise<'module' | 'commonjs' | null>} The "type" of the nearest package.json, or null when it
 *   sets neither type.
 */
async function findPackageType(folder) {
  let packageFolder = folder;
  let packageText = null;
  let packageType = null;

  while (packageText === null) {
    try {
      packageText = await readFile(join(packageFolder, 'package.json'), 'utf8');
    } catch (error) {
      // An unreadable package.json gives no module type, and an error here would hide the load failure.
      if (!MISSING_FILE_CODES.has(error.code) || dirname(packageFolder) === packageFolder) return null;
      packageFolder = dirname(packageFolder);
    }
  }
  try {
    packageType = JSON.parse(packageText).type;
  } catch {
    return null;
  }

  return packageType === 'module' || packageType === 'commonjs' ? packageType : null;
}
