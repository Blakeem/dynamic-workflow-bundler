import { simulateFileScenario } from '../src/simulate-file-scenario.js';

/**
 * @param {string} script
 * @param {import('../src/check-scenarios.js').FileScenario} fileScenario
 * @param {string} scenariosFile
 * @returns {Promise<import('../src/format-trace-line.js').Simulation>}
 */
export async function simulateScenario(script, fileScenario, scenariosFile) {
  const { name, expect } = fileScenario;
  const trace = await simulateFileScenario(script, fileScenario, scenariosFile);

  return { script: trace.script, scenario: name, expect, passed: trace.end.kind === expect, trace };
}
