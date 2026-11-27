import { createInspection } from './create-inspection.js';
import { isObject } from './is-object.js';
import { SIMULATE_OPTION_KEYS, simulate } from './simulate.js';
import { UsageError } from './usage-error.js';

/** @typedef {import('./create-inspection.js').Inspection} Inspection */

// Checked here as well as in simulate(), so that the message for an unknown key names inspect().
const INSPECT_OPTION_KEYS = new Set([...SIMULATE_OPTION_KEYS, 'call']);

/**
 * Runs one simulation as `simulate()` runs it, and gives its inspection: the events of the trace in order
 * with each call summarized, or with `call` that one call in full. Writes and prints nothing.
 * Rejects with the UsageError of `simulate()` for each options value it rejects once `call` is left out,
 * and with a UsageError for an unknown key and for a `call` that is not the index of a call of the trace.
 * @param {{ script: string, scenario?: import('./simulate.js').Scenario, call?: number }} options `script` and
 *   `scenario` as `simulate()` takes them. `call` is the index of a call, from 0.
 * @returns {Promise<Inspection>}
 */
export async function inspect(options = /** @type {{ script: string }} */ ({})) {
  /** @type {unknown} */
  let simulateOptions = options;
  /** @type {unknown} */
  let call;

  // A value that is not an object reaches simulate() as it came, so that the rejection is simulate()'s.
  if (isObject(options)) {
    const unknownKey = Object.keys(options).find((key) => !INSPECT_OPTION_KEYS.has(key));
    if (unknownKey !== undefined) throw new UsageError(`inspect() takes no option ${unknownKey}`);
    // Read by name, as simulate() reads its options, so that an inherited script or scenario still reaches it.
    simulateOptions = { script: options.script, scenario: options.scenario };
    call = options.call;
  }
  const trace = await simulate(/** @type {{ script: string }} */ (simulateOptions));

  return createInspection(trace, call);
}
