import { formatHiddenCharacters } from './format-hidden-characters.js';
import { simulate } from './simulate.js';
import { UsageError } from './usage-error.js';

/**
 * Simulates one scenario of a scenarios file. Rejects with a UsageError that names the script, the scenario
 * and the scenarios file for each problem `simulate()` rejects for, with that rejection as its `cause`, since
 * `simulate()` names neither the scenario nor its file, such as for a respond function that throws.
 * @param {string} script The workflow script, as `simulate()` takes it.
 * @param {import('./check-scenarios.js').FileScenario} fileScenario
 * @param {string} scenariosFile The scenarios file, as the message names it.
 * @returns {Promise<import('./simulate.js').Trace>}
 */
export async function simulateFileScenario(script, { name, scenario }, scenariosFile) {
  try {
    return await simulate({ script, scenario });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    const failure = new UsageError(`The simulation of ${script} with the scenario "${formatHiddenCharacters(name)}" of ${scenariosFile} cannot run. ${error.message}`);
    failure.cause = error;
    throw failure;
  }
}
