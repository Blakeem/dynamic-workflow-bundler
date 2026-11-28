import { formatCount } from './format-count.js';
import { formatHiddenCharacters } from './format-hidden-characters.js';
import { formatSimulationEnd } from './format-simulation-end.js';

/**
 * @typedef {object} Simulation One scenario's simulation, as `dwfb simulate` reports it.
 * @property {string} script The script, as the trace names it.
 * @property {string} scenario The scenario's name.
 * @property {'returned' | 'threw'} expect
 * @property {boolean} passed True when the trace's end kind is `expect`.
 * @property {import('./simulate.js').Trace} trace
 */

/**
 * @param {Simulation} simulation
 * @returns {string} Such as `review.js passes: returned, 1 call.`
 */
export function formatTraceLine({ script, scenario, trace }) {
  return `${script} ${formatHiddenCharacters(scenario)}: ${formatSimulationEnd(trace)}, ${formatCount(trace.calls.length, 'call')}.`;
}
