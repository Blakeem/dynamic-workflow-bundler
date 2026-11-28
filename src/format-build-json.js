/**
 * @param {{ result: import('./build.js').BuildResult, out: string }[]} builtWorkflows Each `out` as
 *   formatRealDisplayPath gives it.
 * @param {boolean} isSuccess
 * @returns {object} The `--json` shape of `dwfb build`, which is part of the public interface. Every path takes
 *   the form BuildResult gives it, except `out`, which takes the form formatRealDisplayPath gives it.
 */
export function formatBuildJson(builtWorkflows, isSuccess) {
  return {
    ok: isSuccess,
    workflows: builtWorkflows.map(({ result, out }) => ({
      // A build reads the entry first, so its first source names the entry against the base of the other paths.
      entry: result.sources[0],
      out,
      status: result.status,
      bytes: result.script === null ? null : Buffer.byteLength(result.script, 'utf8'),
      sources: result.sources,
      findings: result.findings,
      ...(result.firstDifference === undefined ? {} : { firstDifference: result.firstDifference }),
    })),
  };
}
