import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatDocumentFileLine } from '../src/format-document-file-line.js';
import { formatPromptSnapshot } from '../src/format-prompt-snapshot.js';
import { formatSnapshotJson } from '../src/format-snapshot-json.js';
import { formatSnapshotText } from '../src/format-snapshot-text.js';
import { CONFIG_FILES_TEXT } from '../src/load-config.js';
import { formatRealDisplayPath } from '../src/real-path.js';
import { snapshot } from '../src/snapshot.js';
import { validate } from '../src/validate.js';
import { PROMPT_SNAPSHOT_KIND } from './document-kinds.js';
import { loadTargetScenarios } from './load-target-scenarios.js';
import { readScriptName } from './read-script-name.js';
import { runDocumentCommand } from './run-document-command.js';
import { isFreshOutcome, writeDocument } from './write-document.js';

const SNAPSHOT_USAGE = `Usage: dwfb snapshot [<script>] [--scenarios <file>] [--out <file>] [--check] [--config <path>] [--json] [--help]

Runs a workflow script against each scenario of a scenarios file with no model call, as the runtime of
Claude Code ${CONTRACT_RUNTIME_VERSION} runs it, and writes its prompt snapshot: a Markdown document that holds one
copy of each distinct prompt of each role. With a script and no --scenarios, reads the scenarios file of the
workflow of the config file whose out is the script. The prompt snapshot goes to --out, else to the snapshot of
that workflow, else to stdout. With no script, writes the snapshot of each workflow of the config file that has
snapshot.

A variant is one distinct prompt of a role. Two prompts of one role are one variant when they have one schema
and are equal once three masks are applied in this order: the item of the call's label becomes <item> where no
letter or digit touches it, unless the later masks turn the item into one N, each UUID and each lowercase hex
word of 8 or more characters becomes N, and each run of digits becomes N. The role of a call is the longest role
of the script that its label starts with, else its label, else (no label). The promptBudgets of the config
workflow give each role the most characters its largest prompt may hold.

Options:
  --scenarios <file>   Read the scenarios of the script from this file.
  --out <file>         Write the prompt snapshot to this file.
  --check              Write nothing, and report each prompt snapshot file that differs from the prompt
                       snapshot the script and its scenarios give.
  --config <path>      Read this config file in place of ${CONFIG_FILES_TEXT}.
  --json               Print the result as one JSON object, and write no file. With --check, the check
                       key of each script with a prompt snapshot is fresh, stale or missing.
  --help               Print this help.
`;

/** @typedef {import('./find-document-targets.js').DocumentTarget} DocumentTarget */

/**
 * @typedef {import('../src/format-snapshot-json.js').SnapshotJsonTarget & { target: DocumentTarget, document: string | null }} SnapshotTarget
 *   With the prompt snapshot in `document`, or null when a scenario is unread or no scenario makes a call.
 */

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function runSnapshot(args) {
  return runDocumentCommand(PROMPT_SNAPSHOT_KIND, args, SNAPSHOT_USAGE, { readTarget: readSnapshotTarget, writeTarget: writePromptSnapshot, formatJson: formatSnapshotJson });
}

/**
 * @param {DocumentTarget} target
 * @returns {Promise<SnapshotTarget>}
 */
async function readSnapshotTarget(target) {
  let result = null;
  let fileLabel = null;
  let document = null;
  let findings = [];

  // loadTargetScenarios names the workflow of a scenarios file that does not load, which snapshot() cannot name.
  await loadTargetScenarios(target);
  result = await snapshot({ script: target.script, scenarios: target.scenariosFile, promptBudgets: target.promptBudgets ?? undefined });
  if (target.file !== null) fileLabel = await formatRealDisplayPath(target.file);
  if (result.variants !== null && result.callCount > 0) document = formatPromptSnapshot(await readScriptName(target.script), result.variants);
  if (result.unread.length > 0) findings = (await validate({ script: target.script })).findings;

  return { target, result, fileLabel, document, findings };
}

/**
 * Writes, compares or prints one prompt snapshot.
 * @param {SnapshotTarget} snapshotTarget
 * @param {boolean} isCheck
 * @returns {Promise<import('./run-document-command.js').DocumentOutput>} With isSuccess false for an unread
 *   scenario, a script with no call, a stale file or a prompt budget problem.
 */
async function writePromptSnapshot({ target, result, fileLabel, document, findings }, isCheck) {
  let outcome = null;
  let fileLine = null;

  // The document is the entire output on stdout, so that it can be redirected to a file.
  if (document !== null && target.file === null) return { text: document, isSuccess: result.ok, isWritten: false };
  if (document !== null) {
    outcome = await writeDocument(/** @type {string} */ (target.file), document, isCheck);
    fileLine = formatDocumentFileLine(outcome, /** @type {string} */ (fileLabel), PROMPT_SNAPSHOT_KIND.name, result.script);
  }

  return { text: formatSnapshotText(result, findings, fileLine), isSuccess: result.ok && (outcome === null || isFreshOutcome(outcome)), isWritten: outcome === 'wrote' };
}
