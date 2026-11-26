import { extname } from 'node:path';
import { Parser, parse } from 'acorn';
import { findJsonError } from './find-json-error.js';
import { formatSyntaxErrorReason } from './parse-source.js';
import { findPosition } from './source-position.js';

// An ES module allows no top-level return, unlike the body of a workflow script.
const MODULE_PARSE_OPTIONS = Object.freeze({ ecmaVersion: 'latest', sourceType: 'module' });
// Node runs a CommonJS file inside a function, which allows a top-level return.
const COMMONJS_PARSE_OPTIONS = Object.freeze({ ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
// That function also allows a top-level new.target. Acorn 8.19.0 has no option for it, so this overrides the getter its parser reads.
const CommonJsParser = Parser.extend((BaseParser) => class extends BaseParser {
  get allowNewDotTarget() {
    return true;
  }
});
// Acorn 8.19.0 gives these reasons where a CommonJS parse meets module syntax, which Node.js 24.22.1 reparses as an ES module.
// It gives the top-level reason first for an import or export declaration inside a block or function.
const MODULE_SYNTAX_REASONS = new Set([
  "'import' and 'export' may appear only with 'sourceType: module'",
  "'import' and 'export' may only appear at the top level",
  "Cannot use 'import.meta' outside a module",
]);
const JAVASCRIPT_ENDINGS = new Set(['.js', '.mjs', '.cjs']);
const IMPORT_TYPES = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration']);
const RELATIVE_SPECIFIER_PATTERN = /^\.\.?\//;

/**
 * @typedef {object} ModuleSyntaxError
 * @property {number} line 1-based.
 * @property {number} column 1-based.
 * @property {string} reason
 */

/**
 * Parses one file of an ES module graph by its ending and module type: a .mjs file as an ES module, a .cjs
 * file as CommonJS, a .js file as an ES module or as CommonJS, and a .json file as JSON. A file of another
 * ending gives no syntax error and no import.
 * @param {string} text The normalized text of the file.
 * @param {string} file
 * @param {boolean} [isEsModule] False for a .js file that Node loads as CommonJS. Defaults to true.
 * @returns {{ syntaxError: ModuleSyntaxError | null, importSpecifiers: string[] }} The specifiers of the
 *   static imports and re-exports by a path that starts with ./ or ../, in source order. Empty for a
 *   CommonJS file, which loads no ES import.
 */
export function checkModuleSyntax(text, file, isEsModule = true) {
  const ending = extname(file);
  const isCommonJs = ending === '.cjs' || (ending === '.js' && !isEsModule);
  let program = null;

  if (ending === '.json') {
    const jsonError = findJsonError(text);
    return { syntaxError: jsonError === null ? null : formatSyntaxError(text, jsonError.offset, jsonError.reason), importSpecifiers: [] };
  }
  if (!JAVASCRIPT_ENDINGS.has(ending)) return { syntaxError: null, importSpecifiers: [] };
  try {
    program = parseFile(text, isCommonJs);
  } catch (error) {
    if (!(error instanceof SyntaxError) || typeof error.pos !== 'number') throw error;
    return { syntaxError: formatSyntaxError(text, error.pos, formatSyntaxErrorReason(error)), importSpecifiers: [] };
  }
  if (isCommonJs) return { syntaxError: null, importSpecifiers: [] };

  const importSpecifiers = program.body
    .filter((statement) => IMPORT_TYPES.has(statement.type) && statement.source)
    .map((statement) => statement.source.value)
    .filter((specifier) => RELATIVE_SPECIFIER_PATTERN.test(specifier));
  return { syntaxError: null, importSpecifiers };
}

/**
 * Tells module syntax, such as an `import` statement or `import.meta`, by Node's rule for a .js file of a
 * package with no "type" field: the CommonJS parse fails on an `import` or an `export`, at the top level or
 * nested, or on `import.meta`, or the text parses as an ES module and not as a CommonJS file, such as for a
 * top-level `await` (Node.js 24.22.1).
 * Node also counts a top-level `const` or `let` of a CommonJS name such as `require`, which this leaves out.
 * @param {string} text The normalized text of the file.
 * @returns {boolean}
 */
export function hasModuleSyntax(text) {
  const commonJsReason = findParseReason(text, true);

  if (commonJsReason === null) return false;

  return MODULE_SYNTAX_REASONS.has(commonJsReason) || findParseReason(text, false) === null;
}

/**
 * @param {string} text
 * @param {boolean} isCommonJs True to parse the text as a CommonJS file, false as an ES module.
 * @returns {string | null} The reason of the syntax error, or null for text that parses.
 */
function findParseReason(text, isCommonJs) {
  try {
    parseFile(text, isCommonJs);
  } catch (error) {
    if (error instanceof SyntaxError) return formatSyntaxErrorReason(error);
    throw error;
  }
  return null;
}

/**
 * @param {string} text
 * @param {boolean} isCommonJs True to parse the text as a CommonJS file, false as an ES module.
 * @returns {import('acorn').Program}
 */
function parseFile(text, isCommonJs) {
  return isCommonJs ? CommonJsParser.parse(text, COMMONJS_PARSE_OPTIONS) : parse(text, MODULE_PARSE_OPTIONS);
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
