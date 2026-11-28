/**
 * @param {import('./simulate.js').Trace} trace
 * @returns {boolean} True when the simulation stopped or the script was refused, so the script did not reach an
 *   end of its own and no reader takes its calls as a full path.
 */
export function isUnfinishedTrace({ end }) {
  return end.kind === 'stopped' || end.kind === 'refused';
}
