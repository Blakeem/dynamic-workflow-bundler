import { formatFinding } from './format-finding.js';
import { formatTraceLine } from './format-trace-line.js';

/**
 * @param {import('./format-trace-line.js').Simulation[]} simulations In the order run.
 * @returns {string} One line per simulation, after the findings of each refused script the first time it is
 *   refused, then the counts of passed and failed scenarios.
 */
export function formatSimulateText(simulations) {
  const refusedScripts = new Set();
  const passedCount = simulations.filter((simulation) => simulation.passed).length;
  const lines = [];

  for (const simulation of simulations) {
    const { end } = simulation.trace;
    if (end.kind === 'refused' && !refusedScripts.has(simulation.script)) {
      refusedScripts.add(simulation.script);
      lines.push(...end.findings.map(formatFinding));
    }
    lines.push(formatSimulationLine(simulation));
  }
  lines.push(`${passedCount} passed, ${simulations.length - passedCount} failed.`);

  return lines.map((line) => `${line}\n`).join('');
}

/**
 * @param {import('./format-trace-line.js').Simulation} simulation
 * @returns {string} Such as `FAILED review.js no reviewer: stopped at call 1 (label "review"): <message>, 2 calls.`
 */
function formatSimulationLine(simulation) {
  return `${simulation.passed ? '' : 'FAILED '}${formatTraceLine(simulation)}`;
}
