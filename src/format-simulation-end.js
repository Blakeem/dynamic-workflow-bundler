import { formatCallName } from './find-scripted-return.js';
import { formatHiddenCharacters } from './format-hidden-characters.js';

/**
 * @param {import('./simulate.js').Trace} trace
 * @returns {string} How the simulation ended, such as `returned` or `threw TypeError: <message>`.
 */
export function formatSimulationEnd({ end, calls }) {
  if (end.kind === 'returned' || end.kind === 'refused') return end.kind;
  if (end.kind === 'threw') return `threw ${formatHiddenCharacters(end.name)}: ${formatHiddenCharacters(end.message)}`;
  // The node-lacks-name stop comes before the script runs and the never-settles stop at no call, so neither names one.
  if (!('call' in end)) return `stopped: ${formatHiddenCharacters(end.message)}`;
  return `stopped at ${formatCallName(calls[end.call])}: ${formatHiddenCharacters(end.message)}`;
}
