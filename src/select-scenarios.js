import { formatHiddenCharacters } from './format-hidden-characters.js';
import { UsageError } from './usage-error.js';

/**
 * @param {import('./check-scenarios.js').FileScenario[]} fileScenarios
 * @param {string | undefined} name The name `--scenario` gives.
 * @param {string} scenariosFile
 * @returns {import('./check-scenarios.js').FileScenario[]} Every scenario when name is undefined, else the
 *   one scenario of that name.
 */
export function selectScenarios(fileScenarios, name, scenariosFile) {
  const namedScenarios = fileScenarios.filter((fileScenario) => fileScenario.name === name);

  if (name === undefined) return fileScenarios;
  if (namedScenarios.length === 0) throw new UsageError(`The scenarios file ${scenariosFile} holds no scenario named "${formatHiddenCharacters(name)}"`);

  return namedScenarios;
}

/**
 * @param {import('./check-scenarios.js').FileScenario[]} fileScenarios
 * @param {string | undefined} name The name `--scenario` gives.
 * @param {string} scenariosFile
 * @returns {import('./check-scenarios.js').FileScenario} The scenario of that name, or with no name the one
 *   scenario of the file, as `dwfb inspect` runs one scenario.
 */
export function selectInspectScenario(fileScenarios, name, scenariosFile) {
  const names = fileScenarios.map((fileScenario) => `"${formatHiddenCharacters(fileScenario.name)}"`);

  if (name !== undefined) return selectScenarios(fileScenarios, name, scenariosFile)[0];
  if (fileScenarios.length === 1) return fileScenarios[0];

  throw new UsageError(`The scenarios file ${scenariosFile} holds ${fileScenarios.length} scenarios, so name one with --scenario <name>: ${names.join(', ')}`);
}
