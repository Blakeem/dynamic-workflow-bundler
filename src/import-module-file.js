import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkModuleSyntax, hasModuleSyntax } from './check-module-syntax.js';
import { isFolderPath } from './display-path.js';
import { formatErrorCause } from './format-error-cause.js';
import { MISSING_FILE_CODES } from './load-sources.js';
import { normalizeSourceText } from './normalize-source-text.js';
import { formatOversizeReason, READ_BYTE_LIMIT } from './read-byte-limit.js';
import { formatRealDisplayPath } from './real-path.js';
import { UsageError } from './usage-error.js';

// The endings of a file that Node may load as CommonJS, which it compiles only as it runs it.
const COMMONJS_ENDINGS = new Set(['.js', '.cjs']);
const COMPILED_FILE_LINE_PATTERN = /^(.+):\d+\n/;
const [NODE_MAJOR_VERSION, NODE_MINOR_VERSION] = process.versions.node.split('.').map(Number);
// Node.js 22.7.0 unflagged syntax detection, which loads a .js file of a package with no "type" as an ES
// module when the file holds module syntax.
export const IS_MODULE_SYNTAX_DETECTED = NODE_MAJOR_VERSION > 22 || (NODE_MAJOR_VERSION === 22 && NODE_MINOR_VERSION >= 7);

/**
 * Imports a file the user wrote, such as a config file, as an ES module. Node keeps each module it loads by
 * its real path, so a later call in the same process, by any spelling of the path, reads the file as the
 * first call loaded it.
 * Rejects with a UsageError for a missing file, a folder or a path that ends in a path separator or a `.` or
 * `..` segment, and a file that fails to load. For a syntax error the message names the file and line that
 * does not parse.
 * @param {string} path Relative to the working directory, or absolute.
 * @param {string} fileLabel The file as each message opens with it, such as `The config file dwfb.config.js`.
 * @param {string} moduleFileRecovery The recovery that gives the file a .mjs ending, which a message names
 *   when Node loads the file as CommonJS, such as `rename it to a .mjs file`.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
export async function importModuleFile(path, fileLabel, moduleFileRecovery) {
  let fileStats = null;
  let realFile = '';
  const file = resolve(path);

  try {
    fileStats = await stat(file);
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) throw new UsageError(`${fileLabel} does not exist`);
    throw error;
  }
  if (isFolderPath(path) || !fileStats.isFile()) throw new UsageError(`${fileLabel} is not a file`);
  // Windows file names ignore letter case, and realpath gives the stored spelling of a path the user wrote, so
  // every spelling of one file shares one module record.
  realFile = await realpath(file);
  try {
    return await import(pathToFileURL(realFile).href);
  } catch (error) {
    throw new UsageError(await formatLoadFailure(error, file, fileLabel, moduleFileRecovery));
  }
}

/**
 * Imports a file as importModuleFile does and gives what checkDefault returns for its default export.
 * Rejects as importModuleFile does, with each UsageError that checkDefault throws, and with a UsageError that
 * names the cause for any other error that checkDefault throws.
 * @template T
 * @param {string} path As importModuleFile takes it.
 * @param {string} fileLabel As importModuleFile takes it.
 * @param {string} moduleFileRecovery As importModuleFile takes it.
 * @param {(value: unknown) => T} checkDefault Checks the default export and throws a UsageError for a wrong one.
 * @returns {Promise<T>}
 */
export async function importCheckedDefault(path, fileLabel, moduleFileRecovery, checkDefault) {
  const fileModule = await importModuleFile(path, fileLabel, moduleFileRecovery);

  try {
    return checkDefault(fileModule.default);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // A read of the default export can run the file's code, such as a getter that throws.
    throw new UsageError(`${fileLabel} does not load. ${await formatErrorCause(error)}`);
  }
}

/**
 * @param {unknown} error What the import rejected with.
 * @param {string} file The imported file's absolute path.
 * @param {string} fileLabel As importModuleFile takes it.
 * @param {string} moduleFileRecovery As importModuleFile takes it.
 * @returns {Promise<string>}
 */
async function formatLoadFailure(error, file, fileLabel, moduleFileRecovery) {
  const cause = await formatErrorCause(error);
  let parseFailure = null;
  let place = '';

  if (!(error instanceof SyntaxError)) return `${fileLabel} does not load. ${cause}`;
  // Node's module loader realpaths the imported file, so it reads the imports and the package.json of a link's target.
  parseFailure = await findParseFailure(await realpath(file), await findCompiledFile(error));
  if (parseFailure === null) return `${fileLabel} does not load. ${cause}`;
  if ('size' in parseFailure) {
    return `${fileLabel} does not load. ${cause}. The file ${parseFailure.file} is ${formatOversizeReason(parseFailure.size)}, so the place of the syntax error is unknown`;
  }
  place = `${parseFailure.file}:${parseFailure.line}:${parseFailure.column} ${parseFailure.reason}`;
  if (!parseFailure.isModuleSyntaxInCommonJs) return `${fileLabel} does not load. ${place}`;
  // Node loaded the file as CommonJS, where an `import` or `export` statement is a syntax error.
  if (parseFailure.isImportedFile) {
    return `${fileLabel} does not load. ${cause}. ${formatModuleSyntaxRecovery(parseFailure.isTypeFieldIgnored, moduleFileRecovery)}`;
  }

  return `${fileLabel} does not load. ${place}. ${formatModuleSyntaxRecovery(parseFailure.isTypeFieldIgnored, 'rename it to a .mjs file')}`;
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
 * @param {SyntaxError} error What the import of the file rejected with.
 * @returns {Promise<string | null>} The real path of the CommonJS file whose compile threw the error, or null
 *   for an error thrown as code runs, such as from JSON.parse.
 */
async function findCompiledFile(error) {
  let compiledFile = null;

  try {
    // Node.js 24.22.1 opens the stack of a CommonJS compile error with the file's absolute path and the line.
    compiledFile = COMPILED_FILE_LINE_PATTERN.exec(error.stack)?.[1] ?? null;
  } catch {
    // The imported file's code can give a SyntaxError a stack that throws as it is read or turned into text.
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
 * Finds the file of an imported file's static imports that does not parse, since Node's syntax error names no
 * file and no line (Node.js 24.22.1).
 * Node compiles each ES module and parses each JSON file depth first in source order as it loads the graph,
 * and stops at the first that fails. It compiles a CommonJS file only as it runs it, after the entire graph
 * loaded, so a module that runs before it can throw first. So the search takes that order, reads only files
 * that Node read, and gives a CommonJS failure only when no ES module or JSON file fails and Node's error
 * names that file as the one it compiled. It parses each file as the module type Node loads it as, and
 * follows the imports of an ES module only. It skips a device or a pipe, and reads no file larger than
 * READ_BYTE_LIMIT. Of those larger files it skips each one that loads as CommonJS, other than the one Node's
 * error names, and gives the first other one it reaches. When Node's error names a compiled file, it gives
 * such a file other than that one only when it finds no CommonJS failure.
 * A syntax error that a module throws as it runs, such as from JSON.parse, names no compiled file, so the
 * search cannot tell it from an ES module's compile error. It then gives the first larger file it reaches
 * that it does not skip, and null when it reaches none.
 * @param {string} importedFile The imported file's real path.
 * @param {string | null} compiledFile As findCompiledFile gives it.
 * @returns {Promise<ParseFailure | OversizedFile | null>}
 */
async function findParseFailure(importedFile, compiledFile) {
  const pendingFiles = [importedFile];
  const seenFiles = new Set();
  let commonJsFailure = null;
  let oversizedFile = null;

  while (pendingFiles.length > 0) {
    // Node's module loader realpaths each module it loads, so it resolves an import against its importer's real path.
    const file = await realpath(/** @type {string} */ (pendingFiles.pop()));
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const fileStats = await stat(file);
    // A device or a pipe reports a size of 0, and its read may never end.
    if (!fileStats.isFile()) continue;
    const { size } = fileStats;
    if (size > READ_BYTE_LIMIT) {
      // A CommonJS file that Node's error does not name is not the file that fails, and the search follows none of its imports.
      if (file !== compiledFile && COMMONJS_ENDINGS.has(extname(file)) && (await findSetModuleType(file)) === 'commonjs') continue;
      const oversized = { file: await formatRealDisplayPath(file), size };
      // Node compiles the CommonJS file its error names after every ES module and JSON file, so no other file fails.
      if (compiledFile === null || file === compiledFile) return oversized;
      oversizedFile ??= oversized;
      continue;
    }
    const text = normalizeSourceText(await readFile(file, 'utf8'));
    const isCommonJs = COMMONJS_ENDINGS.has(extname(file)) && !(await isEsModuleFile(file, text));
    const { syntaxError, importSpecifiers } = checkModuleSyntax(text, file, !isCommonJs);
    if (syntaxError !== null && !isCommonJs) return createParseFailure(file, syntaxError, file === importedFile, false);
    if (syntaxError !== null && file === compiledFile) {
      commonJsFailure = await createParseFailure(file, syntaxError, file === importedFile, hasModuleSyntax(text));
    }
    const importedFiles = importSpecifiers.map((specifier) => findImportedFile(specifier, file)).filter((path) => path !== null);
    pendingFiles.push(...importedFiles.reverse());
  }

  return commonJsFailure ?? oversizedFile;
}

/**
 * @typedef {object} ParseFailure
 * @property {string} file Relative to the real path of the working directory, as a build names each source.
 * @property {number} line
 * @property {number} column
 * @property {string} reason
 * @property {boolean} isImportedFile True for the file importModuleFile imports, false for a file it imports.
 * @property {boolean} isTypeFieldIgnored True for a .cjs file, which Node loads as CommonJS whatever the
 *   package.json "type" sets.
 * @property {boolean} isModuleSyntaxInCommonJs True for a file that loads as CommonJS and holds module syntax.
 */

/**
 * @typedef {object} OversizedFile A file larger than READ_BYTE_LIMIT, which findParseFailure does not read.
 * @property {string} file Relative to the real path of the working directory, as ParseFailure names it.
 * @property {number} size In bytes.
 */

/**
 * @param {string} file The real path of the file that does not parse.
 * @param {import('./check-module-syntax.js').ModuleSyntaxError} syntaxError
 * @param {boolean} isImportedFile
 * @param {boolean} isModuleSyntaxInCommonJs
 * @returns {Promise<ParseFailure>}
 */
async function createParseFailure(file, syntaxError, isImportedFile, isModuleSyntaxInCommonJs) {
  return { file: await formatRealDisplayPath(file), ...syntaxError, isImportedFile, isTypeFieldIgnored: extname(file) === '.cjs', isModuleSyntaxInCommonJs };
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
 * @param {string} file A `.js` or `.cjs` file.
 * @param {string} text The file's normalized text.
 * @returns {Promise<boolean>} True for a file that Node loads as an ES module: a `.js` file whose nearest
 *   package.json sets `"type": "module"`, or one of a package with no "type" that holds module syntax.
 */
async function isEsModuleFile(file, text) {
  const moduleType = await findSetModuleType(file);

  if (moduleType !== null) return moduleType === 'module';

  return hasModuleSyntax(text);
}

/**
 * @param {string} file A `.js` or `.cjs` file.
 * @returns {Promise<'module' | 'commonjs' | null>} The module type Node loads the file as whatever its text
 *   holds: 'commonjs' for a `.cjs` file, and for a `.js` file the "type" of its nearest package.json. Null for a
 *   `.js` file of a package with no "type", which Node loads as an ES module when the file holds module syntax.
 */
async function findSetModuleType(file) {
  let packageType = null;

  if (extname(file) === '.cjs') return 'commonjs';
  packageType = await findPackageType(dirname(file));
  if (packageType !== null) return packageType;

  return IS_MODULE_SYNTAX_DETECTED ? null : 'commonjs';
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
