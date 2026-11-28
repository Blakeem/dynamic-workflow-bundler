import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatDocumentFileLine } from '../src/format-document-file-line.js';
import { formatFinding } from '../src/format-finding.js';
import { formatFlowMap } from '../src/format-flow-map.js';
import { formatHiddenCharacters } from '../src/format-hidden-characters.js';
import { formatMapJson } from '../src/format-map-json.js';
import { CONFIG_FILES_TEXT } from '../src/load-config.js';
import { map } from '../src/map.js';
import { formatRealDisplayPath } from '../src/real-path.js';
import { validate } from '../src/validate.js';
import { FLOW_MAP_KIND } from './document-kinds.js';
import { loadTargetScenarios } from './load-target-scenarios.js';
import { readScriptName } from './read-script-name.js';
import { runDocumentCommand } from './run-document-command.js';
import { isFreshOutcome, writeDocument } from './write-document.js';

const MAP_USAGE = `Usage: dwfb map [<script>] [--scenarios <file>] [--out <file>] [options]

Runs a workflow script against each scenario of a scenarios file with no model call, as the runtime of
Claude Code ${CONTRACT_RUNTIME_VERSION} runs it, and writes the flow map of every path the scenarios reach: a
Markdown document with one Mermaid diagram. With a script and no --scenarios, reads the scenarios file of the
workflow of the config file whose out is the script. The flow map goes to --out, else to the map of that
workflow, else to stdout. With no script, writes the map of each workflow of the config file that has map.

A scenario is mapped only when its script follows these rules. Each agent() call has a label. Each label
starts with a role. A role is the text before the first \${...} of a label string in the script. The script
returns an object whose status is a string of 1 or more characters, or its scenario has an endState. An error
that the script throws on purpose is created by the throw new <Name>(...) statement that throws it. After the
top level of the script or a lane starts a parallel() or pipeline() group, it makes no agent() call of its own
before the last call made in that group or in a group started inside it. A lane is one thunk of a parallel() or
one item of a pipeline().

Options:
  --scenarios <file>   Read the scenarios of the script from this file.
  --out <file>         Write the flow map to this file.
                       An existing file must be a flow map that dwfb map wrote.
  --check              Write nothing, and report each flow map file that differs from the flow map the
                       script and its scenarios give.
  --config <path>      Read this config file in place of ${CONFIG_FILES_TEXT}.
  --json               Print the result as one JSON object, and write no file. With --check, the check
                       key of each mapped script is fresh, stale or missing.
  --help               Print this help.
`;

/** @typedef {import('./find-document-targets.js').DocumentTarget} DocumentTarget */

/**
 * @typedef {import('../src/format-map-json.js').MapJsonTarget & { target: DocumentTarget, document: string | null }} MappedTarget
 *   With the flow map in `document`, or null when a scenario is unmapped.
 */

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function runMap(args) {
  return runDocumentCommand(FLOW_MAP_KIND, args, MAP_USAGE, { readTarget: mapTarget, writeTarget: writeFlowMap, formatJson: formatMapJson });
}

/**
 * @param {DocumentTarget} target
 * @returns {Promise<MappedTarget>}
 */
async function mapTarget(target) {
  let result = null;
  let fileLabel = null;
  let document = null;
  let findings = [];

  // loadTargetScenarios names the workflow of a scenarios file that does not load, which map() cannot name.
  await loadTargetScenarios(target);
  result = await map({ script: target.script, scenarios: target.scenariosFile });
  if (target.file !== null) fileLabel = await formatRealDisplayPath(target.file);
  if (result.ok) document = formatFlowMap(await readScriptName(target.script), /** @type {import('../src/build-flow-graph.js').FlowGraph} */ (result.graph));
  else findings = (await validate({ script: target.script })).findings;

  return { target, result, fileLabel, document, findings };
}

/**
 * Writes, compares or prints one flow map.
 * @param {MappedTarget} mappedTarget
 * @param {boolean} isCheck
 * @returns {Promise<import('./run-document-command.js').DocumentOutput>} With isSuccess false for an unmapped
 *   scenario or a stale file.
 */
async function writeFlowMap({ target, result, fileLabel, document, findings }, isCheck) {
  let outcome = null;

  if (document === null) {
    const lines = [...findings.map(formatFinding), ...result.unmapped.map(({ scenario, reason }) => `${result.script} ${formatHiddenCharacters(scenario)}: not mapped, since ${reason}.`)];
    return { text: lines.map((line) => `${line}\n`).join(''), isSuccess: false, isWritten: false };
  }
  if (target.file === null) return { text: document, isSuccess: true, isWritten: false };

  outcome = await writeDocument(target.file, document, isCheck);
  return { text: `${formatDocumentFileLine(outcome, /** @type {string} */ (fileLabel), FLOW_MAP_KIND.name, result.script)}\n`, isSuccess: isFreshOutcome(outcome), isWritten: outcome === 'wrote' };
}
