import { extname } from 'node:path';
import { parse } from 'acorn';
import { findJsonError } from './find-json-error.js';
import { formatSyntaxErrorReason } from './parse-source.js';
import { findPosition } from './source-position.js';

// A config file is an ES module, which allows no top-level return, unlike the body of a workflow script.
const MODULE_PARSE_OPTIONS = Object.freeze({ ecmaVersion: 'latest', sourceType: 'module' });
// Node runs a CommonJS file inside a function, which allows a top-level return.
const COMMONJS_PARSE_OPTIONS = Object.freeze({ ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
const MODULE_ENDINGS = new Set(['.js', '.mjs']);
const IMPORT_TYPES = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration']);
const RELATIVE_SPECIFIER_PATTERN = /^\.\.?\//;

/**
 * @typedef {object} ModuleSyntaxError
 * @property {number} line 1-based.
 * @property {number} column 1-based.
 * @property {string} reason
 */

/**
 * Parses one file of an ES module graph by its ending, a .js or .mjs file as an ES module and a .json file
 * as JSON. A file of another ending gives no syntax error and no import.
 * @param {string} text The normalized text of the file.
 * @param {string} file
 * @returns {{ syntaxError: ModuleSyntaxError | null, importSpecifiers: string[] }} The specifiers of the
 *   static imports and re-exports by a path that starts with ./ or ../, in source order.
 */
export function checkModuleSyntax(text, file) {
  const ending = extname(file);
  let program = null;

  if (ending === '.json') {
    const jsonError = findJsonError(text);
    return { syntaxError: jsonError === null ? null : formatSyntaxError(text, jsonError.offset, jsonError.reason), importSpecifiers: [] };
  }
  if (!MODULE_ENDINGS.has(ending)) return { syntaxError: null, importSpecifiers: [] };
  try {
    program = parse(text, MODULE_PARSE_OPTIONS);
  } catch (error) {
    if (!(error instanceof SyntaxError) || typeof error.pos !== 'number') throw error;
    return { syntaxError: formatSyntaxError(text, error.pos, formatSyntaxErrorReason(error)), importSpecifiers: [] };
  }

  const importSpecifiers = program.body
    .filter((statement) => IMPORT_TYPES.has(statement.type) && statement.source)
    .map((statement) => statement.source.value)
    .filter((specifier) => RELATIVE_SPECIFIER_PATTERN.test(specifier));
  return { syntaxError: null, importSpecifiers };
}

/**
 * Tells module syntax, such as an `import` statement or `import.meta`, by Node's rule for a .js file of a
 * package with no "type" field: the text parses as an ES module and not as a CommonJS file (Node.js 24.22.1).
 * Node also counts a top-level `const` or `let` of a CommonJS name such as `require`, which this leaves out.
 * @param {string} text The normalized text of the file.
 * @returns {boolean}
 */
export function hasModuleSyntax(text) {
  return isParsed(text, MODULE_PARSE_OPTIONS) && !isParsed(text, COMMONJS_PARSE_OPTIONS);
}

/**
 * @param {string} text
 * @param {import('acorn').Options} options
 * @returns {boolean}
 */
function isParsed(text, options) {
  try {
    parse(text, options);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return true;
}

/**
 * @param {string} text
 * @param {number} offset
 * @param {string} reason
 * @returns {ModuleSyntaxError}
 */
function formatSyntaxError(text, offset, reason) {
  return { ...findPosition(text, offset), reason };
}
