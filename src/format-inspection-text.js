import { AGENT_CALL_LIMIT, isPastCallLimit } from './contract.js';
import { formatCallName } from './find-scripted-return.js';
import { formatCount } from './format-count.js';
import { formatFinding } from './format-finding.js';
import { formatHiddenCharacters } from './format-hidden-characters.js';
import { formatTraceLine } from './format-trace-line.js';

const LATE_CALL_LINE = 'no return, since the script had settled and the scenario holds no usable scripted return for this call';
const LATE_CAP_LINE = `no return, since the script had settled and the call came after the cap of ${AGENT_CALL_LIMIT} agent() calls`;

/**
 * @param {import('./format-trace-line.js').Simulation} simulation
 * @param {import('./create-inspection.js').Inspection} inspection
 * @returns {string} The lines a person reads: for a refused script its findings and the line of how the
 *   simulation ended, else one call in full, else that line and then one line per event. That line is the
 *   line of `dwfb simulate` with no `FAILED ` mark.
 */
export function formatInspectionText(simulation, inspection) {
  const { end } = simulation.trace;

  if (end.kind === 'refused') return [...end.findings.map(formatFinding), formatTraceLine(simulation)].map((line) => `${line}\n`).join('');
  if (inspection.call !== undefined) return formatInspectionCallText(simulation, inspection.call, end);

  return [formatTraceLine(simulation), ...(inspection.events ?? []).map(formatEventLine)].map((line) => `${line}\n`).join('');
}

/**
 * @param {import('./create-inspection.js').InspectionEvent} event
 * @returns {string} One line, since each title, text and label goes through formatHiddenCharacters.
 */
function formatEventLine(event) {
  if (event.kind === 'phase') return `phase "${formatHiddenCharacters(event.title)}"`;
  if (event.kind === 'log') return `log ${formatHiddenCharacters(event.text)}`;
  return formatCallEventLine(event);
}

/**
 * @param {Extract<import('./create-inspection.js').InspectionEvent, { kind: 'call' }>} event
 * @returns {string} Such as `call 0 (label "review"): prompt of 32 characters, returned an object.`
 */
function formatCallEventLine(event) {
  const parts = [];

  if (event.phase !== null) parts.push(`phase "${formatHiddenCharacters(event.phase)}"`);
  if (event.group !== null) parts.push(formatGroupPart(event.group));
  parts.push(`prompt of ${formatCount(event.promptLength, 'character')}`, formatReturnedPart(event));

  return `${formatCallName(event)}: ${parts.join(', ')}.`;
}

/**
 * @param {import('./create-inspection.js').InspectionGroup} group
 * @returns {string} Such as `parallel 0 item 2` or `pipeline 1 item 0 stage 1`.
 */
function formatGroupPart({ index, kind, item, stage }) {
  return kind === 'parallel' ? `parallel ${index} item ${item}` : `pipeline ${index} item ${item} stage ${stage}`;
}

/**
 * @param {{ returnedType: 'string' | 'object' | 'null' | 'none', returnedLength: number | null }} event
 * @returns {string}
 */
function formatReturnedPart({ returnedType, returnedLength }) {
  if (returnedType === 'string') return `returned a string of ${formatCount(/** @type {number} */ (returnedLength), 'character')}`;
  if (returnedType === 'object') return 'returned an object';
  if (returnedType === 'null') return 'returned null';
  return 'no return';
}

/**
 * @param {import('./format-trace-line.js').Simulation} simulation
 * @param {import('./create-inspection.js').InspectionCall} call
 * @param {import('./simulate.js').TraceEnd} end
 * @returns {string}
 */
function formatInspectionCallText({ script, scenario }, call, end) {
  const { phase, group, opts, prompt } = call;
  const phaseLine = phase === null ? 'phase: none' : `phase: "${formatHiddenCharacters(phase)}"`;
  // A trace gives null opts both for no options and for options JSON cannot hold, such as a BigInt.
  const optionsText = opts === null ? 'options: none, or options that JSON cannot hold\n' : `options:\n${JSON.stringify(opts, null, 2)}\n`;

  return [
    `${formatCallName(call)} of ${script} ${formatHiddenCharacters(scenario)}\n`,
    `${phaseLine}\n`,
    `${formatGroupLine(group)}\n`,
    optionsText,
    `prompt of ${formatCount(prompt.length, 'character')}:\n${formatWithLineEnd(prompt)}`,
    formatReturnedText(call, end),
  ].join('');
}

/**
 * @param {import('./create-inspection.js').InspectionGroup | null} group
 * @returns {string}
 */
function formatGroupLine(group) {
  if (group === null) return 'group: none';
  if (group.kind === 'parallel') return `group: parallel ${group.index}, item ${group.item} of ${group.items}`;
  return `group: pipeline ${group.index}, item ${group.item} of ${group.items}, stage ${group.stage} of ${group.stages}`;
}

/**
 * @param {import('./create-inspection.js').InspectionCall} call
 * @param {import('./simulate.js').TraceEnd} end
 * @returns {string}
 */
function formatReturnedText(call, end) {
  const isStoppedCall = end.kind === 'stopped' && 'call' in end && end.call === call.index;

  if (isStoppedCall) return `stopped: ${formatHiddenCharacters(end.message)}\n`;
  // Any other call with no returned key was made after the script settled, where a stop ends nothing.
  if (!Object.hasOwn(call, 'returned')) return isPastCallLimit(call.index) ? `${LATE_CAP_LINE}\n` : `${LATE_CALL_LINE}\n`;
  if (call.returned === null) return 'returned: null, an agent that died\n';
  if (typeof call.returned === 'string') return `returned a string of ${formatCount(call.returned.length, 'character')}:\n${formatWithLineEnd(call.returned)}`;
  return `returned:\n${JSON.stringify(call.returned, null, 2)}\n`;
}

/**
 * @param {string} text
 * @returns {string} The text with a line end added when it ends with none, so the next line starts on its own line.
 */
function formatWithLineEnd(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}
