import { findPosition } from './source-position.js';

/**
 * @typedef {object} Finding
 * @property {string} rule The rule id.
 * @property {string} message What is wrong, with no closing period.
 * @property {string} fix How to fix it, with no closing period.
 * @property {string} file The source file. A real path until the build reports it.
 * @property {number} line 1-based.
 * @property {number} column 1-based.
 */

/** How to fix each rule's finding. */
export const FIXES = Object.freeze({
  'syntax-error': 'Correct the syntax',
  'meta-not-first': 'Make export const meta = { ... } the first statement of the entry',
  'meta-not-alone': 'Start it on the next line',
  'meta-reads-import': 'Write the value into the meta statement, since the built script declares imported names after it',
  'entry-export': 'Move the export into a module',
  'import-not-relative': 'Import a source file by a path that starts with ./ or ../',
  'import-not-module': 'Import a .js or .mjs file with no import attributes',
  'import-not-found': 'Correct the path or create the file',
  'import-not-exported': 'Import a name that the module exports',
  'import-cycle': 'Move the code that the modules share into a module that imports none of them',
  'import-dynamic': 'Use a static import at the top level',
  'import-meta': 'Remove import.meta, since a built script has no module URL',
  'export-not-constant': 'Export a const, and keep state that changes in an exported object or function',
  'export-from': 'Import the names, then export them',
  'module-top-level-await': 'Move it into a function, or into the entry',
  'module-top-level-this': 'Use undefined in its place, or move it into a function',
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
