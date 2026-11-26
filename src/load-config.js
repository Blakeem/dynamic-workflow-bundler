import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkConfig } from './check-config.js';
import { checkModuleSyntax, hasModuleSyntax } from './check-module-syntax.js';
import { formatDisplayPath, isFolderPath } from './display-path.js';
import { MISSING_FILE_CODES } from './load-sources.js';
import { normalizeSourceText } from './normalize-source-text.js';
import { findRealPath, formatRealDisplayPath } from './real-path.js';
import { UsageError } from './usage-error.js';

/** @typedef {import('./check-config.js').Config} Config */

// A .mjs config file loads as an ES module in every package, and a .js file only in some.
const CONFIG_FILES = Object.freeze(['dwfb.config.js', 'dwfb.config.mjs']);
/** The config files that a command looks for in the working directory when no `--config` names another. */
export const CONFIG_FILES_TEXT = CONFIG_FILES.join(' or ');
// The endings of a file that Node may load as CommonJS, which it compiles only as it runs it.
const COMMONJS_ENDINGS = new Set(['.js', '.cjs']);
const COMPILED_FILE_LINE_PATTERN = /^(.+):\d+\n/;

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
const [NODE_MAJOR_VERSION, NODE_MINOR_VERSION] = process.versions.node.split('.').map(Number);
// Node.js 22.7.0 unflagged syntax detection, which loads a .js file of a package with no "type" as an ES
// module when the file holds module syntax.
export const IS_MODULE_SYNTAX_DETECTED = NODE_MAJOR_VERSION > 22 || (NODE_MAJOR_VERSION === 22 && NODE_MINOR_VERSION >= 7);

/**
 * Loads the config file a command reads, as loadConfig does: the one `--config` names, else the one of
 * CONFIG_FILES_TEXT that exists in the working directory.
 * Rejects with a UsageError when no `--config` is given and both files exist, since the command cannot tell
 * which one the project means.
 * @param {string | undefined} configPath The path `--config` names.
 * @returns {Promise<{ file: string, config: Config } | null>} The config file as the messages name it, and its
 *   config. Null when no `--config` is given and neither file exists.
 */
export async function loadCommandConfig(configPath) {
  const file = configPath ?? findConfigFile();

  if (file === null) return null;
  if (configPath !== undefined) return { file, config: await loadConfig(file) };

  return { file, config: await readConfig(file, true) };
}

/**
 * @returns {string | null} The config file's name, or null when neither exists.
 */
function findConfigFile() {
  const existingFiles = CONFIG_FILES.filter((file) => existsSync(file));

  if (existingFiles.length > 1) {
    throw new UsageError(`The config files ${existingFiles.join(' and ')} both exist here, so remove one or name one with --config <path>`);
  }

  return existingFiles[0] ?? null;
}

/**
 * Loads a config file as an ES module and checks its default export. Node keeps each module it loads, so
 * a later call in the same process reads the file as the first call loaded it.
 * Rejects with a UsageError for a path that is not a string, a missing file, a folder or a path that ends in a
 * path separator or a `.` or `..` segment, a file that fails to load, a default export that throws as
 * checkConfig reads it, and every problem that checkConfig names.
 * @param {string} path The config file, relative to the working directory or absolute.
 * @returns {Promise<Config>} Every path absolute.
 */
export async function loadConfig(path) {
  if (typeof path !== 'string' || path === '') throw new UsageError('loadConfig() needs path, the path of a config file');

  return readConfig(path, false);
}

/**
 * @param {string} path
 * @param {boolean} isFoundFile True for a file the working directory lookup found. A rename of it to
 *   dwfb.config.mjs then replaces no file and keeps it found, since the lookup found no second config file.
 * @returns {Promise<Config>}
 */
async function readConfig(path, isFoundFile) {
  let configStats = null;
  let configModule = null;
  const configFile = resolve(path);

  try {
    configStats = await stat(configFile);
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) throw new UsageError(`The config file ${path} does not exist`);
    throw error;
  }
  if (isFolderPath(path) || !configStats.isFile()) throw new UsageError(`The config file ${path} is not a file`);
  try {
    configModule = await import(pathToFileURL(configFile).href);
  } catch (error) {
    throw new UsageError(await formatLoadFailure(error, configFile, path, isFoundFile));
  }
  try {
    return checkConfig(configModule.default, configFile, path);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // A read of the default export can run the config file's code, such as a getter that throws.
    throw new UsageError(`The config file ${path} does not load. ${await formatErrorCause(error)}`);
  }
}

/**
 * @param {unknown} error What the import of the config file rejected with, or what its code threw.
 * @returns {Promise<string>} The error's message with no absolute path and no closing period, or a fixed cause
 *   for a value with no text.
 */
async function formatErrorCause(error) {
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
 * @param {unknown} error What the import rejected with.
 * @param {string} configFile
 * @param {string} path The config file's path as the caller gave it.
 * @param {boolean} isFoundFile As readConfig takes it.
 * @returns {Promise<string>}
 */
async function formatLoadFailure(error, configFile, path, isFoundFile) {
  const cause = await formatErrorCause(error);
  // A found file that loads as CommonJS is dwfb.config.js, since a .mjs file loads as an ES module.
  const moduleFileRecovery = isFoundFile ? `rename it to ${CONFIG_FILES[1]}` : 'name a .mjs config file with --config';
  let parseFailure = null;
  let place = '';

  if (!(error instanceof SyntaxError)) return `The config file ${path} does not load. ${cause}`;
  // Node's module loader realpaths the config file, so it reads the imports and the package.json of a link's target.
  parseFailure = await findParseFailure(await realpath(configFile), await findCompiledFile(error));
  if (parseFailure === null) return `The config file ${path} does not load. ${cause}`;
  place = `${parseFailure.file}:${parseFailure.line}:${parseFailure.column} ${parseFailure.reason}`;
  if (!parseFailure.isModuleSyntaxInCommonJs) return `The config file ${path} does not load. ${place}`;
  // Node loaded the file as CommonJS, where an `import` or `export` statement is a syntax error.
  if (parseFailure.isConfigFile) {
    return `The config file ${path} does not load. ${cause}. ${formatModuleSyntaxRecovery(parseFailure.isTypeFieldIgnored, moduleFileRecovery)}`;
  }

  return `The config file ${path} does not load. ${place}. ${formatModuleSyntaxRecovery(parseFailure.isTypeFieldIgnored, 'rename it to a .mjs file')}`;
}

/**
 * @param {boolean} isTypeFieldIgnored As ParseFailure holds it.
 * @param {string} moduleFileRecovery The recovery that gives the file a .mjs ending.
 * @returns {string}
 */
function formatModuleSyntaxRecovery(isTypeFieldIgnored, moduleFileRecovery) {
  const typeRecovery = isTypeFieldIgnored ? '' : 'set "type": "module" in the nearest package.json, or ';

  return `If the file is an ES module, ${typeRecovery}${moduleFileRecovery}`;
}

/**
 * @param {SyntaxError} error What the import of the config file rejected with.
 * @returns {Promise<string | null>} The real path of the CommonJS file whose compile threw the error, or null
 *   for an error thrown as code runs, such as from JSON.parse.
 */
async function findCompiledFile(error) {
  let compiledFile = null;

  try {
    // Node.js 24.22.1 opens the stack of a CommonJS compile error with the file's absolute path and the line.
    compiledFile = COMPILED_FILE_LINE_PATTERN.exec(error.stack)?.[1] ?? null;
  } catch {
    // The config file's code can give a SyntaxError a stack that throws as it is read or turned into text.
    return null;
  }
  if (compiledFile === null || !isAbsolute(compiledFile)) return null;
  try {
    return await realpath(compiledFile);
  } catch {
    // A path that does not resolve names no file that Node compiled, and an error here would hide the load failure.
    return null;
  }
}

/**
 * Finds the file of a config file's static imports that does not parse, since Node's syntax error names no
 * file and no line (Node.js 24.22.1). A syntax error that a module throws as it runs, such as from
 * JSON.parse, gives null.
 * Node compiles each ES module and parses each JSON file depth first in source order as it loads the graph,
 * and stops at the first that fails. It compiles a CommonJS file only as it runs it, after the entire graph
 * loaded, so a module that runs before it can throw first. So the search takes that order, reads only files
 * that Node read, and gives a CommonJS failure only when no ES module or JSON file fails and Node's error
 * names that file as the one it compiled. It parses each file as the module type Node loads it as, and
 * follows the imports of an ES module only.
 * @param {string} configFile The config file's real path.
 * @param {string | null} compiledFile As findCompiledFile gives it.
 * @returns {Promise<ParseFailure | null>}
 */
async function findParseFailure(configFile, compiledFile) {
  const pendingFiles = [configFile];
  const seenFiles = new Set();
  let commonJsFailure = null;

  while (pendingFiles.length > 0) {
    // Node's module loader realpaths each module it loads, so it resolves an import against its importer's real path.
    const file = await realpath(/** @type {string} */ (pendingFiles.pop()));
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const text = normalizeSourceText(await readFile(file, 'utf8'));
    const isCommonJs = COMMONJS_ENDINGS.has(extname(file)) && !(await isEsModuleFile(file, text));
    const { syntaxError, importSpecifiers } = checkModuleSyntax(text, file, !isCommonJs);
    if (syntaxError !== null && !isCommonJs) return createParseFailure(file, syntaxError, file === configFile, false);
    if (syntaxError !== null && file === compiledFile) {
      commonJsFailure = await createParseFailure(file, syntaxError, file === configFile, hasModuleSyntax(text));
    }
    const importedFiles = importSpecifiers.map((specifier) => findImportedFile(specifier, file)).filter((importedFile) => importedFile !== null);
    pendingFiles.push(...importedFiles.reverse());
  }

  return commonJsFailure;
}

/**
 * @typedef {object} ParseFailure
 * @property {string} file Relative to the real path of the working directory, as a build names each source.
 * @property {number} line
 * @property {number} column
 * @property {string} reason
 * @property {boolean} isConfigFile
 * @property {boolean} isTypeFieldIgnored True for a .cjs file, which Node loads as CommonJS whatever the
 *   package.json "type" sets.
 * @property {boolean} isModuleSyntaxInCommonJs True for a file that loads as CommonJS and holds module syntax.
 */

/**
 * @param {string} file The real path of the file that does not parse.
 * @param {import('./check-module-syntax.js').ModuleSyntaxError} syntaxError
 * @param {boolean} isConfigFile
 * @param {boolean} isModuleSyntaxInCommonJs
 * @returns {Promise<ParseFailure>}
 */
async function createParseFailure(file, syntaxError, isConfigFile, isModuleSyntaxInCommonJs) {
  return { file: await formatRealDisplayPath(file), ...syntaxError, isConfigFile, isTypeFieldIgnored: extname(file) === '.cjs', isModuleSyntaxInCommonJs };
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
    // A realpath error, such as for a link that loops, would hide the load failure, so the path keeps its spelling.
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

/**
 * @param {string} file A `.js` or `.cjs` file.
 * @param {string} text The file's normalized text.
 * @returns {Promise<boolean>} True for a file that Node loads as an ES module: a `.js` file whose nearest
 *   package.json sets `"type": "module"`, or one of a package with no "type" that holds module syntax.
 */
async function isEsModuleFile(file, text) {
  let packageType = null;

  if (extname(file) === '.cjs') return false;
  packageType = await findPackageType(dirname(file));
  if (packageType !== null) return packageType === 'module';
  if (!IS_MODULE_SYNTAX_DETECTED) return false;

  return hasModuleSyntax(text);
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
