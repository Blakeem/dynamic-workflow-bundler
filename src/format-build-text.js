import { formatCount } from './format-count.js';
import { formatFinding } from './format-finding.js';
import { formatLineSource } from './format-line-source.js';

/**
 * @param {string} out The built script, as formatRealDisplayPath gives it.
 * @param {import('./build.js').BuildResult} result
 * @param {string} buildCommand The command that rewrites a script that differs or is missing.
 * @returns {string} The lines a person reads for one workflow.
 */
export function formatBuildText(out, result, buildCommand) {
  if (result.status === 'failed') return result.findings.map((finding) => `${formatFinding(finding)}\n`).join('');
  if (result.status === 'fresh') return `${out} matches its source.\n`;
  if (result.status === 'missing') return `${out} does not exist. Run ${buildCommand}.\n`;
  if (result.status === 'stale') return `${out}:${result.firstDifference.line} differs from the script the build gives. ${formatLineSource(result.firstDifference)} Run ${buildCommand}.\n`;

  return `Built ${out} from ${formatCount(result.sources.length, 'source file')}, ${Buffer.byteLength(result.script, 'utf8')} bytes.\n`;
}
