import { CONTRACT_RUNTIME_VERSION } from './contract.js';

/**
 * @typedef {object} SnapshotJsonTarget One script, as `dwfb snapshot --json` reports it.
 * @property {import('./snapshot.js').SnapshotResult} result
 * @property {string | null} fileLabel The prompt snapshot file as formatRealDisplayPath gives it, or null for stdout.
 * @property {import('./finding.js').Finding[]} findings The findings of a refused script, whose scenarios are
 *   each unread with the reason `refused` alone.
 */

/**
 * @param {SnapshotJsonTarget[]} snapshotTargets In the order read.
 * @param {(import('./format-document-file-line.js').DocumentCheck | null)[]} snapshotChecks The `check` key of each snapshot in the
 *   same order: how its prompt snapshot file compares with `--check`, and null with no `--check` and for a script
 *   with no prompt snapshot.
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape of `dwfb snapshot`, which is part of the public interface.
 */
export function formatSnapshotJson(snapshotTargets, snapshotChecks, isSuccess) {
  return {
    ok: isSuccess,
    runtime: CONTRACT_RUNTIME_VERSION,
    snapshots: snapshotTargets.map(({ result, fileLabel, findings }, index) => ({ script: result.script, file: fileLabel, check: snapshotChecks[index], ...result, findings })),
  };
}
