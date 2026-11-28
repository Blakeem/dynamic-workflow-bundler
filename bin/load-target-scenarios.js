import { loadScenarios } from '../src/load-scenarios.js';
import { UsageError } from '../src/usage-error.js';

/**
 * @param {import('./find-script-target.js').SimulationTarget} target
 * @returns {Promise<import('../src/check-scenarios.js').FileScenario[]>}
 */
export async function loadTargetScenarios({ scenariosFile, entry }) {
  try {
    return await loadScenarios(scenariosFile);
  } catch (error) {
    if (!(error instanceof UsageError) || entry === null) throw error;
    // loadScenarios() names the scenarios file alone, which names no workflow of the config file.
    const failure = new UsageError(`The scenarios of the workflow whose entry is ${entry} cannot load. ${error.message}`);
    failure.cause = error;
    throw failure;
  }
}
