import { formatSimulationEnd } from './format-simulation-end.js';
import { isUnfinishedTrace } from './is-unfinished-trace.js';

/**
 * @typedef {object} UnreadScenario
 * @property {string} scenario The scenario's name.
 * @property {string} reason How its simulation ended, as formatSimulationEnd gives it.
 */

/**
 * @param {{ name: string, trace: import('./simulate.js').Trace }[]} runs One per scenario, in file order.
 * @returns {UnreadScenario[]} Each scenario whose simulation stopped or whose script was refused, in file order.
 */
export function listUnreadScenarios(runs) {
  return runs.filter(({ trace }) => isUnfinishedTrace(trace)).map(({ name, trace }) => ({ scenario: name, reason: formatSimulationEnd(trace) }));
}
