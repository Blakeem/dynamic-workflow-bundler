import { CONTRACT_RUNTIME_VERSION } from './contract.js';

/**
 * @typedef {object} MapJsonTarget One mapped script, as `dwfb map --json` reports it.
 * @property {import('./map.js').MapResult} result
 * @property {string | null} fileLabel The flow map file as formatRealDisplayPath gives it, or null for stdout.
 * @property {import('./finding.js').Finding[]} findings The findings of a refused script, whose scenarios are
 *   each unmapped with the reason `refused` alone.
 */

/**
 * @param {MapJsonTarget[]} mappedTargets In the order mapped.
 * @param {(import('./format-document-file-line.js').DocumentCheck | null)[]} mapChecks The `check` key of each map in the same order: how its flow map file
 *   compares with `--check`, and null with no `--check` and for a script with an unmapped scenario.
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape of `dwfb map`, which is part of the public interface.
 */
export function formatMapJson(mappedTargets, mapChecks, isSuccess) {
  return {
    ok: isSuccess,
    runtime: CONTRACT_RUNTIME_VERSION,
    maps: mappedTargets.map(({ result, fileLabel, findings }, index) => ({ script: result.script, file: fileLabel, check: mapChecks[index], ...result, findings })),
  };
}
