import { AsyncLocalStorage } from 'node:async_hooks';
import { promiseHooks } from 'node:v8';
import { createContext, runInContext, Script } from 'node:vm';
import { wrapScriptBody } from './compile-script.js';
import { RUNTIME_GLOBAL_NAMES } from './contract.js';
import { readMetaObject } from './meta-statement.js';
import { PARSE_OPTIONS, parseSource } from './parse-source.js';
import { installRuntimeGlobals } from './runtime-globals.js';

/** @typedef {import('./runtime-globals.js').InstalledRuntime} InstalledRuntime */

/**
 * @typedef {{ kind: 'returned', value: unknown } | { kind: 'threw', name: string, message: string } | { kind: 'stopped' }} SimulationEnd
 *   How the script ended. `value` is the JSON value the runtime reports for the return. `stopped` when
 *   `answerCall` threw a SimulationStop before the script settled.
 */

/**
 * @typedef {object} GroupStamp The group an agent() call runs in.
 * @property {number} group The index of the group in `groups`.
 * @property {number} item The index of the thunk or the item, from 0.
 * @property {number} stage The index of the stage, from 0. A parallel() thunk runs in stage 0.
 */

/**
 * @typedef {object} Group One parallel() or pipeline() invocation.
 * @property {'parallel' | 'pipeline'} kind
 * @property {number} items The count of thunks or items.
 * @property {number} stages 1 for parallel().
 */

/**
 * @typedef {object} Phase One phase() invocation.
 * @property {string} title `String` of the argument.
 * @property {number} beforeCall The count of agent() calls made before it.
 */

/**
 * @typedef {object} AgentCall The arguments of one agent() call.
 * @property {unknown} prompt
 * @property {unknown} opts
 * @property {Readonly<GroupStamp> | null} group
 */

/**
 * @typedef {object} SimulationOptions
 * @property {unknown} [args] A JSON value, or absent for no args.
 * @property {{ total?: number | null, spent?: number, spentPerCall?: number }} [budget]
 * @property {(call: AgentCall) => unknown} answerCall Gives the value of one agent() call, and the script
 *   gets a copy of it made as a list leaving parallel() is copied. A thrown error, or a promise it gives
 *   that rejects, rejects that call, and the script gets that error itself. A SimulationStop thrown or
 *   rejected that way ends the simulation instead, and the call never settles.
 */

/**
 * @typedef {object} SimulationResult The part of a trace that the runtime stand-in records. It holds no
 *   call.
 * @property {SimulationEnd} end
 * @property {string[]} logs
 * @property {Phase[]} phases
 * @property {Group[]} groups In call order.
 */

/**
 * @typedef {object} TimerEntry
 * @property {number} due The virtual time the timer runs at, in milliseconds.
 * @property {Function} callback
 * @property {Readonly<GroupStamp> | undefined} groupStamp The group of the setTimeout() invocation.
 */

/** Claude Code 2.1.332 stops a script whose code before its first await runs longer than this. */
export const SCRIPT_TIME_LIMIT_MS = 30000;
// The runtime's message names its own limit, so it stays the same when a test sets a shorter one.
const TIMEOUT_MESSAGE = `Script execution timed out after ${SCRIPT_TIME_LIMIT_MS}ms`;
const NEVER_SETTLES_MESSAGE = 'The script waits on a promise that never settles';
// The texts Claude Code 2.1.332 gives for a return it cannot report.
const FUNCTION_RESULT_MESSAGE = 'workflow result cannot be a function';
const CYCLE_RESULT_MESSAGE = 'JSON.stringify cannot serialize cyclic structures.';
const BIGINT_RESULT_MESSAGE = 'JSON.stringify cannot serialize BigInt';
// Claude Code 2.1.332 names the compiled code so in a stack trace.
const SCRIPT_FILE_NAME = 'workflow.js';
const TIMEOUT_CODE = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
// Claude Code 2.1.332 refuses code generation from strings, and its global object holds no WebAssembly.
const CONTEXT_OPTIONS = Object.freeze({ codeGeneration: Object.freeze({ strings: false, wasm: false }) });
const CYCLE = Symbol('cycle');
// The group index of a parallel() or pipeline() invocation after the simulation ended, which records none.
const NO_GROUP = -1;
const hasInstance = Function.prototype[Symbol.hasInstance];
const ignoreRejection = () => {};
// A context that runs no script reads no args and no budget.
const IDLE_SETTINGS = Object.freeze({ globalNames: RUNTIME_GLOBAL_NAMES, argsText: undefined, budgetTotal: null, budgetSpent: 0, budgetSpentPerCall: 0 });

/** Ends a simulation at the agent() call whose `answerCall` throws it, so the script runs no further. */
export class SimulationStop extends Error {
  constructor() {
    super('The simulation stopped at an agent() call');
    this.name = 'SimulationStop';
  }
}

/**
 * Runs a workflow script as the runtime of Claude Code 2.1.332 runs it, with no model call: each agent()
 * call gets what `answerCall` gives, once agent() has checked the call's schema. Time is virtual. A timer
 * runs once no other code of the script can run and no answer is pending, so a wait of any length ends at
 * once. A timer callback that throws ends nothing, as an unhandled rejection ends nothing, since the
 * runtime's handling of it was not measured.
 * Rejects when the text does not parse, does not open with the meta statement, or has a body that does not
 * compile. It checks no other rule of the contract, so a script the runtime refuses for another rule runs.
 * @param {string} text The entire script.
 * @param {SimulationOptions} options
 * @param {number} [scriptTimeLimit] The limit in milliseconds on the code before the first await. Only a
 *   test passes it, to reach the limit fast.
 * @returns {Promise<SimulationResult>}
 */
export async function runSimulation(text, options, scriptTimeLimit = SCRIPT_TIME_LIMIT_MS) {
  const settings = readSettings(options);
  const script = new Script(`${wrapScriptBody(text, readMetaEnd(text))}()`, { filename: SCRIPT_FILE_NAME });
  const { simulation, host } = createSimulation(options.answerCall);
  const { context, runtime } = createScriptContext(host, settings);
  const stopIgnoringRejections = ignoreScriptRejections(runtime.ScriptPromise);
  const stopRecordingSettled = recordSettledPromises(simulation.settledPromises);
  let end = null;

  try {
    end = await runScript(script, context, scriptTimeLimit, simulation, runtime);
  } finally {
    simulation.isActive = false;
    stopRecordingSettled();
    // Code the script queued before it ended still runs, and may reject.
    await waitForIdle();
    stopIgnoringRejections();
  }

  return { end, logs: simulation.logs, phases: simulation.phases, groups: simulation.groups };
}

/**
 * @returns {string[]} The names of RUNTIME_GLOBAL_NAMES that a simulation's global object lacks, since the
 *   running Node does not define them, such as Temporal on Node 24.
 */
export function listMissingGlobalNames() {
  const { context } = createScriptContext(createSimulation(() => null).host, IDLE_SETTINGS);
  const definedNames = new Set(runInContext('Object.getOwnPropertyNames(globalThis)', context));

  return RUNTIME_GLOBAL_NAMES.filter((name) => !definedNames.has(name));
}

/**
 * @param {import('./runtime-globals.js').RuntimeHost} host
 * @param {import('./runtime-globals.js').RuntimeSettings} settings
 * @returns {{ context: import('node:vm').Context, runtime: InstalledRuntime }}
 */
function createScriptContext(host, settings) {
  const context = createContext(Object.create(null), CONTEXT_OPTIONS);
  const installRuntime = runInContext(`(${installRuntimeGlobals})`, context);

  return { context, runtime: installRuntime(host, settings) };
}

/**
 * @param {SimulationOptions} options
 * @returns {import('./runtime-globals.js').RuntimeSettings}
 */
function readSettings(options) {
  const budget = options?.budget ?? {};
  const budgetTotal = budget.total ?? null;
  const budgetSpent = budget.spent ?? 0;
  const budgetSpentPerCall = budget.spentPerCall ?? 0;
  let argsText;

  if (typeof options?.answerCall !== 'function') throw new TypeError('runSimulation needs options.answerCall, a function');
  if (typeof budget !== 'object') throw new TypeError('options.budget must be an object of total, spent and spentPerCall');
  if (budgetTotal !== null && typeof budgetTotal !== 'number') throw new TypeError('options.budget.total must be a number or null');
  if (typeof budgetSpent !== 'number') throw new TypeError('options.budget.spent must be a number');
  if (!isSpentPerCall(budgetSpentPerCall)) throw new TypeError('options.budget.spentPerCall must be a finite number of 0 or more');
  try {
    argsText = options.args === undefined ? undefined : JSON.stringify(options.args);
  } catch (error) {
    throw new TypeError(`options.args must be a JSON value. ${error.message}`, { cause: error });
  }
  if (options.args !== undefined && argsText === undefined) throw new TypeError('options.args must be a JSON value');
  return { globalNames: RUNTIME_GLOBAL_NAMES, argsText, budgetTotal, budgetSpent, budgetSpentPerCall };
}

/**
 * Infinity is refused, since the spent count before the first answer would be Infinity * 0, which is NaN.
 * @param {unknown} value
 * @returns {boolean} True for a number that a budget can add for each answered call.
 */
export function isSpentPerCall(value) {
  return Number.isFinite(value) && /** @type {number} */ (value) >= 0;
}

/**
 * @param {string} text
 * @returns {number} The offset just after the meta statement.
 */
function readMetaEnd(text) {
  const first = parseSource(text, PARSE_OPTIONS).body[0];

  if (readMetaObject(first) === null) throw new Error('The script does not open with export const meta = { ... }, so the runtime refuses it');
  return first.end;
}

/**
 * @param {SimulationOptions['answerCall']} answerCall
 */
function createSimulation(answerCall) {
  const groupStore = new AsyncLocalStorage();
  const simulation = {
    isActive: true,
    // A stop ends the simulation only before the script's promise settles, and the earlier of the two wins.
    /** @type {Promise<unknown> | null} */
    scriptPromise: null,
    /** @type {WeakSet<Promise<unknown>>} */
    settledPromises: new WeakSet(),
    isStopped: false,
    callCount: 0,
    time: 0,
    nextTimerId: 1,
    /** @type {Map<number, TimerEntry>} */
    timers: new Map(),
    /** @type {Set<Promise<void>>} */
    pendingAnswers: new Set(),
    runtimeErrors: new WeakSet(),
    groupStore,
    /** @type {string[]} */
    logs: [],
    /** @type {Phase[]} */
    phases: [],
    /** @type {Group[]} */
    groups: [],
  };
  /** @type {import('./runtime-globals.js').RuntimeHost} */
  const host = {
    log: (line) => {
      if (simulation.isActive) simulation.logs.push(line);
    },
    phase: (title) => {
      if (simulation.isActive) simulation.phases.push({ title, beforeCall: simulation.callCount });
    },
    agent: (prompt, opts, resolve, reject) => answerAgentCall(simulation, answerCall, { prompt, opts, group: groupStore.getStore() ?? null }, resolve, reject),
    setTimeout: (callback, delay) => addTimer(simulation, callback, delay),
    clearTimeout: (id) => {
      simulation.timers.delete(id);
    },
    openGroup: (kind, items, stages) => {
      if (!simulation.isActive) return NO_GROUP;
      return simulation.groups.push({ kind, items, stages }) - 1;
    },
    runInGroup: (group, item, stage, run) => groupStore.run(Object.freeze({ group, item, stage }), run),
    createRuntimeError: (name, message) => {
      const error = Object.assign(Object.create(null), { name, message });

      simulation.runtimeErrors.add(error);
      return error;
    },
  };

  return { simulation, host };
}

/**
 * Settles one agent() call with what `answerCall` gives. A promise it gives keeps the simulation waiting
 * until it settles, and settles nothing once the simulation has ended.
 * @param {ReturnType<typeof createSimulation>['simulation']} simulation
 * @param {SimulationOptions['answerCall']} answerCall
 * @param {AgentCall} call
 * @param {(value: unknown) => void} resolve
 * @param {(reason: unknown) => void} reject
 */
function answerAgentCall(simulation, answerCall, call, resolve, reject) {
  let answer;

  if (!simulation.isActive) return;
  simulation.callCount += 1;
  try {
    answer = answerCall(call);
  } catch (error) {
    rejectAgentCall(simulation, error, reject);
    return;
  }
  if (!isThenable(answer)) {
    resolve(answer);
    return;
  }

  const settled = Promise.resolve(answer).then(
    (value) => {
      if (simulation.isActive) resolve(value);
    },
    (error) => {
      if (simulation.isActive) rejectAgentCall(simulation, error, reject);
    },
  );
  simulation.pendingAnswers.add(settled);
  settled.then(() => simulation.pendingAnswers.delete(settled));
}

/**
 * Rejects one agent() call with what `answerCall` threw, or stops the simulation for a SimulationStop and
 * leaves the call unsettled.
 * @param {ReturnType<typeof createSimulation>['simulation']} simulation
 * @param {unknown} error
 * @param {(reason: unknown) => void} reject
 */
function rejectAgentCall(simulation, error, reject) {
  if (!(error instanceof SimulationStop)) {
    reject(error);
    return;
  }
  if (simulation.settledPromises.has(simulation.scriptPromise)) return;
  simulation.isStopped = true;
  simulation.isActive = false;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isThenable(value) {
  const isObject = value !== null && (typeof value === 'object' || typeof value === 'function');

  return isObject && typeof value.then === 'function';
}

/**
 * @param {ReturnType<typeof createSimulation>['simulation']} simulation
 * @param {unknown} callback A value that is not a function never runs.
 * @param {number} delay A delay that is not a positive number runs as 0.
 * @returns {number} The timer's id.
 */
function addTimer(simulation, callback, delay) {
  const id = simulation.nextTimerId;
  const wait = delay > 0 ? delay : 0;

  simulation.nextTimerId += 1;
  if (typeof callback === 'function') {
    simulation.timers.set(id, { due: simulation.time + wait, callback, groupStamp: simulation.groupStore.getStore() });
  }
  return id;
}

/**
 * @param {Map<number, TimerEntry>} timers
 * @returns {TimerEntry | null} The timer with the smallest due time, the earliest set among equal ones,
 *   removed from `timers`.
 */
function takeNextTimer(timers) {
  let nextId = null;
  let next = null;

  for (const [id, timer] of timers) {
    if (next === null || timer.due < next.due) {
      nextId = id;
      next = timer;
    }
  }
  if (next !== null) timers.delete(nextId);
  return next;
}

/**
 * @param {Script} script
 * @param {import('node:vm').Context} context
 * @param {number} scriptTimeLimit
 * @param {ReturnType<typeof createSimulation>['simulation']} simulation
 * @param {InstalledRuntime} runtime
 * @returns {Promise<SimulationEnd>}
 */
async function runScript(script, context, scriptTimeLimit, simulation, runtime) {
  let scriptPromise = null;

  try {
    scriptPromise = script.runInContext(context, { timeout: scriptTimeLimit });
  } catch (error) {
    if (error?.code !== TIMEOUT_CODE) throw error;
    if (simulation.isStopped) return { kind: 'stopped' };
    return { kind: 'threw', name: 'Error', message: TIMEOUT_MESSAGE };
  }
  simulation.scriptPromise = scriptPromise;

  const outcome = await settleScript(scriptPromise, simulation);

  if (simulation.isStopped) return { kind: 'stopped' };
  if (outcome === null) return { kind: 'threw', name: 'Error', message: NEVER_SETTLES_MESSAGE };
  if (outcome.isRejected) return convertThrown(outcome.value, simulation.runtimeErrors);
  return convertReturned(outcome.value, runtime.copyValue, simulation.runtimeErrors);
}

/**
 * Runs the script's queued code, then its pending answers and timers, until its promise settles.
 * @param {Promise<unknown>} scriptPromise A promise of the script's realm.
 * @param {ReturnType<typeof createSimulation>['simulation']} simulation
 * @returns {Promise<{ isRejected: boolean, value: unknown } | null>} Null when the promise can never settle,
 *   or settles after a stop.
 */
async function settleScript(scriptPromise, simulation) {
  let outcome = null;
  const settle = (isRejected, value) => {
    if (!simulation.isStopped) outcome = { isRejected, value };
  };

  // The host's then, since the script may replace the one of its own realm.
  Promise.prototype.then.call(
    scriptPromise,
    (value) => settle(false, value),
    (value) => settle(true, value),
  );
  await waitForIdle();
  while (outcome === null && !simulation.isStopped) {
    if (simulation.pendingAnswers.size > 0) {
      await Promise.race(simulation.pendingAnswers);
    } else {
      const timer = takeNextTimer(simulation.timers);

      if (timer === null) return null;
      runTimer(simulation, timer);
    }
    await waitForIdle();
  }
  return outcome;
}

/**
 * @param {ReturnType<typeof createSimulation>['simulation']} simulation
 * @param {TimerEntry} timer
 */
function runTimer(simulation, timer) {
  const { callback } = timer;

  simulation.time = timer.due;
  try {
    simulation.groupStore.run(timer.groupStamp, callback);
  } catch {
    // See runSimulation: a timer callback that throws ends nothing.
  }
}

/**
 * Converts a return as the runtime of Claude Code 2.1.332 reports it, measured with six launched scripts.
 * @param {unknown} value
 * @param {InstalledRuntime['copyValue']} copyValue
 * @param {WeakSet<object>} runtimeErrors
 * @returns {SimulationEnd}
 */
function convertReturned(value, copyValue, runtimeErrors) {
  let copy;
  let hasBigInt = false;
  let json;

  if (typeof value === 'function') return { kind: 'threw', name: 'Error', message: FUNCTION_RESULT_MESSAGE };
  try {
    copy = copyValue(value, () => CYCLE);
  } catch (error) {
    if (error === CYCLE) return { kind: 'threw', name: 'TypeError', message: CYCLE_RESULT_MESSAGE };
    return convertThrown(error, runtimeErrors);
  }
  json = JSON.stringify(copy, (key, item) => {
    if (typeof item !== 'bigint') return item;
    hasBigInt = true;
    return null;
  });
  if (hasBigInt) return { kind: 'threw', name: 'TypeError', message: BIGINT_RESULT_MESSAGE };
  return { kind: 'returned', value: json === undefined ? null : JSON.parse(json) };
}

/**
 * An error, a runtime function's error included, gives its name and message. Any other value gives the
 * name Error and its message property, or the value as a string when it has none.
 * @param {unknown} thrown
 * @param {WeakSet<object>} runtimeErrors
 * @returns {SimulationEnd}
 */
function convertThrown(thrown, runtimeErrors) {
  const isError = runtimeErrors.has(thrown) || readTag(thrown) === '[object Error]';
  const message = readField(thrown, 'message');

  if (isError) return { kind: 'threw', name: convertToText(readField(thrown, 'name')), message: convertToText(message) };
  return { kind: 'threw', name: 'Error', message: convertToText(message === undefined ? thrown : message) };
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown} The field, or undefined when the value has no fields or reading it throws.
 */
function readField(value, key) {
  const isObject = value !== null && (typeof value === 'object' || typeof value === 'function');

  try {
    return isObject ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {string} The value's tag, such as [object Error], or '' when reading it throws.
 */
function readTag(value) {
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return '';
  }
}

/**
 * @param {unknown} value
 * @returns {string} `String` of the value, or its tag for a value `String` refuses, such as an object with
 *   no prototype.
 */
export function convertToText(value) {
  try {
    return String(value);
  } catch {
    return readTag(value);
  }
}

/**
 * Keeps each rejected promise of the script's realm from reaching the process as an unhandled rejection,
 * since the runtime ends no script for one, and the process may end on it or a test may fail on it.
 * @param {PromiseConstructor} ScriptPromise
 * @returns {() => void} Stops it.
 */
function ignoreScriptRejections(ScriptPromise) {
  const handlerPromises = new WeakSet();

  return promiseHooks.onSettled((promise) => {
    try {
      if (handlerPromises.has(promise) || !hasInstance.call(ScriptPromise, promise)) return;
      handlerPromises.add(Promise.prototype.then.call(promise, undefined, ignoreRejection));
    } catch {
      // A script that replaced its promises' constructor may throw here, and its rejection then shows.
    }
  });
}

/**
 * Records each promise the moment it settles. The host's then reaction on the script's promise runs only
 * after the microtasks the script queued before it settled, and an agent() call one of them makes comes
 * after the script settled.
 * @param {WeakSet<Promise<unknown>>} settledPromises
 * @returns {() => void} Stops it.
 */
function recordSettledPromises(settledPromises) {
  return promiseHooks.onSettled((promise) => {
    settledPromises.add(promise);
  });
}

/** @returns {Promise<void>} Settles once every queued microtask has run. */
function waitForIdle() {
  return new Promise((resolve) => setImmediate(resolve));
}
