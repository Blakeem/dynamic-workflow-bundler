import { CONTRACT_RUNTIME_VERSION } from './contract.js';

/**
 * @typedef {object} CoverTarget One script, as `dwfb cover` reports it.
 * @property {string} scenarios The scenarios file, as the target of the command names it.
 * @property {import('./cover.js').CoverageResult} result
 */

/**
 * @param {CoverTarget[]} coverTargets In the order covered.
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape of `dwfb cover`, which is part of the public interface.
 */
export function formatCoverJson(coverTargets, isSuccess) {
  return {
    ok: isSuccess,
    runtime: CONTRACT_RUNTIME_VERSION,
    scripts: coverTargets.map(formatScriptCoverage),
  };
}

/**
 * @param {CoverTarget} coverTarget
 * @returns {object}
 */
function formatScriptCoverage({ scenarios, result }) {
  // The runtime is given once, at the top level.
  const { ok, script, runtime, ...coverage } = result;

  return { ok, script, scenarios, ...coverage };
}
