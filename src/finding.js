import { findPosition } from './source-position.js';

/**
 * @typedef {object} Finding
 * @property {string} rule The rule id.
 * @property {string} message What is wrong, with no closing period.
 * @property {string} fix How to fix it, with no closing period.
 * @property {string} file The source that breaks the rule, or the built script for script-stale. A source's
 *   path is a real path until the build reports it.
 * @property {number} line 1-based.
 * @property {number} column 1-based.
 */

/** How to fix the finding of each rule that a source breaks. */
export const FIXES = Object.freeze({
  'syntax-error': 'Correct the syntax',
  'source-too-deep': 'Split the nested code into named constants or functions',
  'meta-not-first': 'Make export const meta = { ... } the first statement of the entry',
  'meta-not-alone': 'Start it on the next line',
  'meta-reads-import': 'Write the value into the meta statement, since the built script declares imported names after it',
  'entry-export': 'Move the export into a module',
  'import-not-relative': 'Import a source file by a path that starts with ./ or ../',
  'import-not-default': 'Import a text file or a JSON file with a default import, as in import prompt from \'./prompt.md\'',
  'import-attribute-unknown': 'Use no attribute other than type, with the value text or json',
  'import-ending-unknown': 'Give the file the ending .js, .mjs or .json, or add with { type: \'text\' } to import it as a string',
  'import-not-found': 'Correct the path or create the file',
  'import-kind-conflict': 'Give every import of the file the same type attribute, or none',
  'json-invalid': 'Correct the JSON',
  'include-not-found': 'Correct the path or create the file',
  'include-misplaced': 'Put the directive alone on its line at the top level of the entry, below the meta statement',
  'include-twice': 'Name each part in one directive, name no part that is the entry, and import no part as a module',
  'source-encoding-invalid': 'Save the file as UTF-8',
  'part-not-plain': 'Make the part a list of complete statements with no import and no export',
  'statement-crosses-part': 'End the statement on the line above, such as with a semicolon, so that each part holds complete statements',
  'import-not-exported': 'Import a name that the module exports',
  'import-cycle': 'Move the code that the modules share into a module that imports none of them',
  'import-dynamic': 'Use a static import at the top level',
  'import-meta': 'Remove import.meta, since a built script has no module URL',
  'export-not-constant': 'Export a const, and keep state that changes in an exported object or function',
  'export-from': 'Import the names, then export them',
  'module-top-level-await': 'Move it into a function, or into the entry',
  'module-top-level-return': 'Move it into a function, or into the entry',
  'module-top-level-this': 'Use undefined in its place, or move it into a function',
  'module-top-level-arguments': 'Read the values as named parameters, or move the code into a function',
  'module-direct-eval': 'Replace the eval call with code, since in the built script it can read the entry\'s names',
  'module-reads-entry-name': 'Rename the entry\'s declaration, since an ES module would read the global of that name',
  'reserved-name': 'Rename it, since the build reserves that name',
});

/**
 * @param {string} rule
 * @param {string} message
 * @param {string} file
 * @param {string} text The text of `file`, which the offset indexes.
 * @param {number} offset
 * @returns {Finding}
 */
export function createFinding(rule, message, file, text, offset) {
  const { line, column } = findPosition(text, offset);
  return { rule, message, fix: FIXES[rule], file, line, column };
}
