import { describeObjectKind, findNonJsonValue, isPlainObject } from './find-non-json-value.js';
import { formatHiddenCharacters } from './format-hidden-characters.js';

/** @typedef {import('./simulate.js').Respond} Respond */
/** @typedef {import('./simulate.js').ScriptedReturn} ScriptedReturn */
/** @typedef {import('./simulate.js').TraceCall} TraceCall */
/** @typedef {Omit<TraceCall, 'returned'>} PendingCall A call that has no scripted return yet. */

const ignoreRejection = () => {};

/**
 * @typedef {{ kind: 'answered', returned: ScriptedReturn }
 *   | { kind: 'stopped', reason: 'unanswered' | 'wrong-type' | 'not-json', message: string }} ScriptedReturnResult
 */

/**
 * @typedef {object} PickedValue
 * @property {unknown} value What respond gives the call, or undefined for no scripted return.
 * @property {string} source What gives it, as a message names it, such as `key "review" of respond`.
 * @property {string | null} unansweredMessage Why respond gives no value, when no source gives one.
 */

/**
 * Finds the scripted return that a scenario's respond gives one agent() call, and reads no disk.
 * For a respond object, the longest key that the call's label starts with decides, and the key '' decides
 * every call, a call with no label included. A list gives the call its element at the count of earlier
 * calls that the key decided. A function, as respond or as a key's value, is called with copies of the
 * call and of the earlier calls, and what it returns is the scripted return.
 * Throws what a respond function throws.
 * @param {Respond | undefined} respond
 * @param {PendingCall} call
 * @param {TraceCall[]} earlierCalls In call order, as the trace records them, so a call made after the
 *   script settled may have no `returned` key.
 * @param {boolean} hasSchema True when the call passes a schema object.
 * @returns {ScriptedReturnResult} `returned` is a JSON copy of the scripted return.
 */
export function findScriptedReturn(respond, call, earlierCalls, hasSchema) {
  const callName = formatCallName(call);
  const expected = hasSchema ? 'a plain object or null' : 'a string or null';
  const { value, source, unansweredMessage } = pickValue(respond, call, earlierCalls, callName);

  if (unansweredMessage !== null) return { kind: 'stopped', reason: 'unanswered', message: unansweredMessage };
  if (value === undefined) return { kind: 'stopped', reason: 'unanswered', message: `${capitalize(source)} gives undefined to ${callName}. Give it ${expected}` };
  return checkScriptedReturn(value, hasSchema, `${capitalize(source)} gives ${callName}`, expected);
}

/**
 * @param {Respond | undefined} respond
 * @param {PendingCall} call
 * @param {TraceCall[]} earlierCalls
 * @param {string} callName
 * @returns {PickedValue}
 */
function pickValue(respond, call, earlierCalls, callName) {
  if (typeof respond === 'function') return callRespondFunction(respond, 'the respond function', call, earlierCalls);

  const keys = Object.keys(respond ?? {});
  const key = findDecidingKey(keys, call.label);

  if (key === null) return { value: undefined, source: 'respond', unansweredMessage: formatNoKeyMessage(callName, call.label) };

  const keyValue = respond[key];
  const keyName = `key ${quote(key)}`;

  if (typeof keyValue === 'function') return callRespondFunction(keyValue, `the function of ${keyName}`, call, earlierCalls);
  if (!Array.isArray(keyValue)) return { value: keyValue, source: `${keyName} of respond`, unansweredMessage: null };

  const useIndex = earlierCalls.filter((earlierCall) => findDecidingKey(keys, earlierCall.label) === key).length;

  if (useIndex >= keyValue.length) return { value: undefined, source: `the list of ${keyName}`, unansweredMessage: formatListEndMessage(keyName, keyValue.length, callName) };
  return { value: keyValue[useIndex], source: `element ${useIndex} of the list of ${keyName}`, unansweredMessage: null };
}

/**
 * @param {string} keyName Such as `key "review"`.
 * @param {number} listLength
 * @param {string} callName
 * @returns {string}
 */
function formatListEndMessage(keyName, listLength, callName) {
  const addText = 'Add a scripted return to the list';

  if (listLength === 0) return `The list of ${keyName} is empty, so it has none for ${callName}. ${addText}`;

  const countText = listLength === 1 ? '1 scripted return' : `${listLength} scripted returns`;

  return `The list of ${keyName} holds ${countText}, which earlier calls used up, so it has none for ${callName}. ${addText}`;
}

/**
 * @param {Function} respondFunction
 * @param {string} source
 * @param {PendingCall} call
 * @param {TraceCall[]} earlierCalls
 * @returns {PickedValue}
 */
function callRespondFunction(respondFunction, source, call, earlierCalls) {
  // Copies, so a function that changes what it gets changes no call of the trace.
  const value = respondFunction(structuredClone(call), structuredClone(earlierCalls));

  // The wrong-type stop drops a promise, so its rejection must not reach the process as unhandled.
  if (value instanceof Promise) Promise.prototype.then.call(value, undefined, ignoreRejection);
  return { value, source, unansweredMessage: null };
}

/**
 * @param {string[]} keys
 * @param {string | null} label
 * @returns {string | null} The longest key that the label starts with, or null when none does.
 */
export function findDecidingKey(keys, label) {
  let decidingKey = null;

  for (const key of keys) {
    const isMatch = key === '' || (label !== null && label.startsWith(key));

    if (isMatch && (decidingKey === null || key.length > decidingKey.length)) decidingKey = key;
  }
  return decidingKey;
}

/**
 * @param {unknown} value Not undefined.
 * @param {boolean} hasSchema
 * @param {string} givesText The start of a message, such as `Key "review" of respond gives call 2 (no label)`.
 * @param {string} expected The values the call takes, as a message names them.
 * @returns {ScriptedReturnResult}
 */
function checkScriptedReturn(value, hasSchema, givesText, expected) {
  const isRecord = value !== null && typeof value === 'object' && isPlainObject(value);

  if (value === null) return { kind: 'answered', returned: null };
  if (!hasSchema && typeof value === 'string') return { kind: 'answered', returned: value };
  if (!hasSchema || !isRecord) {
    const message = `${givesText} ${describeKind(value)}, and a call with ${hasSchema ? 'a schema' : 'no schema'} takes ${expected}. Give it ${expected}`;
    return { kind: 'stopped', reason: 'wrong-type', message };
  }

  const nonJson = findNonJsonValue(value);

  if (nonJson !== null) {
    const message = `${givesText} an object that holds ${nonJson.kind} at ${nonJson.path}, which JSON cannot carry. Give it JSON values only`;
    return { kind: 'stopped', reason: 'not-json', message };
  }
  return { kind: 'answered', returned: JSON.parse(JSON.stringify(value)) };
}

/**
 * @param {string} callName
 * @param {string | null} label
 * @returns {string}
 */
function formatNoKeyMessage(callName, label) {
  if (label === null) return `No key of respond matches ${callName}. Add the key '', which matches a call with no label`;
  return `No key of respond matches ${callName}. Add a key that the label starts with, or the key ''`;
}

/**
 * @param {PendingCall} call
 * @returns {string} Such as `call 2 (label "review")` or `call 0 (no label)`.
 */
export function formatCallName(call) {
  const labelText = call.label === null ? 'no label' : `label ${quote(call.label)}`;

  return `call ${call.index} (${labelText})`;
}

/**
 * @param {string} text A label or a key, which the script or the scenario wrote.
 * @returns {string} The text in double quotes, with each character a terminal does not show as its escape.
 */
function quote(text) {
  return `"${formatHiddenCharacters(text)}"`;
}

/**
 * @param {unknown} value Not null and not undefined.
 * @returns {string} Such as `a number` or `an array`.
 */
function describeKind(value) {
  if (typeof value === 'object') return describeObjectKind(value);
  if (typeof value === 'bigint') return 'a BigInt';
  return `a ${typeof value}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function capitalize(text) {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
