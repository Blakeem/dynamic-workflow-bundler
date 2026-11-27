import { UsageError } from './usage-error.js';

/** @typedef {import('./simulate.js').Trace} Trace */
/** @typedef {import('./simulate.js').TraceCall} TraceCall */
/** @typedef {import('./simulate.js').ScriptedReturn} ScriptedReturn */

/**
 * @typedef {object} InspectionGroup The group a call runs in.
 * @property {number} index The index of the group in the trace's `groups`.
 * @property {'parallel' | 'pipeline'} kind
 * @property {number} item The call's thunk or item, from 0.
 * @property {number} items The count of thunks or items of the group.
 * @property {number} stage The call's stage, from 0. A parallel() thunk runs in stage 0.
 * @property {number} stages 1 for parallel().
 */

/**
 * @typedef {{ kind: 'phase', title: string }
 *   | { kind: 'log', text: string }
 *   | { kind: 'call', index: number, label: string | null, phase: string | null, group: InspectionGroup | null,
 *       promptLength: number, returnedType: 'string' | 'object' | 'null' | 'none', returnedLength: number | null }
 * } InspectionEvent One event of the trace. `returnedType` is 'none' for the call the simulation stopped at,
 *   and `returnedLength` is the length of a string return and null for every other `returnedType`.
 *   `promptLength` and `returnedLength` count UTF-16 code units, as `String.prototype.length` does.
 */

/**
 * @typedef {object} InspectionCall One call in full.
 * @property {number} index
 * @property {string | null} label
 * @property {string | null} phase
 * @property {InspectionGroup | null} group
 * @property {unknown} opts
 * @property {string} prompt
 * @property {ScriptedReturn} [returned] Absent for the call the simulation stopped at.
 */

/**
 * @typedef {object} Inspection What `dwfb inspect` shows of one trace, made of JSON values only.
 * @property {string} script
 * @property {string | null} scenario
 * @property {string} runtime
 * @property {import('./simulate.js').TraceEnd} end
 * @property {number} callCount The length of the trace's `calls`.
 * @property {InspectionEvent[]} [events] The events in the order the script made them, absent with a call.
 * @property {InspectionCall} [call] The call named, absent with no call.
 */

/**
 * Shapes a trace into an inspection: its events in order with each call summarized, or one call in full.
 * Throws a UsageError for a call that is not the index of a call of the trace.
 * @param {Trace} trace
 * @param {unknown} [call] The index of the call to give in full, or undefined for the events.
 * @returns {Inspection}
 */
export function createInspection(trace, call) {
  const head = { script: trace.script, scenario: trace.scenario, runtime: trace.runtime, end: trace.end, callCount: trace.calls.length };

  if (call === undefined) return { ...head, events: trace.events.map((event) => convertEvent(trace, event)) };
  checkCallIndex(call, head.callCount);
  return { ...head, call: convertCall(trace, trace.calls[/** @type {number} */ (call)]) };
}

/**
 * @param {unknown} call
 * @param {number} callCount
 */
function checkCallIndex(call, callCount) {
  if (Number.isInteger(call) && /** @type {number} */ (call) >= 0 && /** @type {number} */ (call) < callCount) return;
  if (callCount === 0) throw new UsageError('The simulation made no call');
  if (callCount === 1) throw new UsageError('The simulation made 1 call, so the one call is 0');
  throw new UsageError(`The simulation made ${callCount} calls, so name a call from 0 to ${callCount - 1}`);
}

/**
 * @param {Trace} trace
 * @param {import('./simulate.js').TraceEvent} event
 * @returns {InspectionEvent}
 */
function convertEvent(trace, event) {
  if (event.kind === 'phase') return { kind: 'phase', title: trace.phases[event.index].title };
  if (event.kind === 'log') return { kind: 'log', text: trace.logs[event.index] };
  const call = trace.calls[event.index];
  const returnedType = findReturnedType(call);

  return {
    kind: 'call',
    index: call.index,
    label: call.label,
    phase: call.phase,
    group: convertGroup(trace, call),
    promptLength: call.prompt.length,
    returnedType,
    returnedLength: returnedType === 'string' ? /** @type {string} */ (call.returned).length : null,
  };
}

/**
 * @param {Trace} trace
 * @param {TraceCall} call
 * @returns {InspectionCall}
 */
function convertCall(trace, call) {
  const { index, label, phase, opts, prompt } = call;
  const inspectionCall = { index, label, phase, group: convertGroup(trace, call), opts, prompt };

  return Object.hasOwn(call, 'returned') ? { ...inspectionCall, returned: call.returned } : inspectionCall;
}

/**
 * @param {Trace} trace
 * @param {TraceCall} call
 * @returns {InspectionGroup | null}
 */
function convertGroup(trace, call) {
  if (call.group === null) return null;
  const { kind, items, stages } = trace.groups[call.group.group];

  return { index: call.group.group, kind, item: call.group.item, items, stage: call.group.stage, stages };
}

/**
 * @param {TraceCall} call
 * @returns {'string' | 'object' | 'null' | 'none'} 'none' for the call the simulation stopped at.
 */
function findReturnedType(call) {
  if (!Object.hasOwn(call, 'returned')) return 'none';
  if (call.returned === null) return 'null';
  return typeof call.returned === 'string' ? 'string' : 'object';
}
