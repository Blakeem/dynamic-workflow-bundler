import { checkScenarios } from './check-scenarios.js';
import { importCheckedDefault } from './import-module-file.js';

/**
 * Loads a scenarios file as an ES module and checks its default export.
 * Rejects with a UsageError for a missing file, a folder or a path that ends in a path separator or a `.` or
 * `..` segment, a file that fails to load, a default export that throws as checkScenarios reads it, and every
 * problem that checkScenarios names.
 * @param {string} path The scenarios file, relative to the working directory or absolute. Each message names
 *   it in this form.
 * @returns {Promise<import('./check-scenarios.js').FileScenario[]>}
 */
export async function loadScenarios(path) {
  return importCheckedDefault(path, `The scenarios file ${path}`, 'rename it to a .mjs file', (value) => checkScenarios(value, path));
}
