import { CONTRACT_RUNTIME_VERSION } from './contract.js';

/**
 * @param {import('./format-trace-line.js').Simulation[]} simulations In the order run.
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape of `dwfb simulate`, which is part of the public interface.
 */
export function formatSimulateJson(simulations, isSuccess) {
  return {
    ok: isSuccess,
    runtime: CONTRACT_RUNTIME_VERSION,
    simulations: simulations.map(({ script, scenario, expect, passed, trace }) => ({ script, scenario, expect, passed, trace })),
  };
}
