import { CONTRACT_RUNTIME_VERSION } from './contract.js';

/**
 * @param {import('./validate.js').ValidateResult[]} results In the order checked.
 * @param {string[]} skipped The out of each workflow that sets `validate: false`, relative to the working
 *   directory's real path.
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape of `dwfb validate`, which is part of the public interface.
 */
export function formatValidateJson(results, skipped, isSuccess) {
  return {
    ok: isSuccess,
    runtime: CONTRACT_RUNTIME_VERSION,
    scripts: results.map(({ script, findings }) => ({ script, findings })),
    skipped,
  };
}
