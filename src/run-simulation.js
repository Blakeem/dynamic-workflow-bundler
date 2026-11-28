import { AsyncLocalStorage } from 'node:async_hooks';
import { promiseHooks } from 'node:v8';
import { createContext, runInContext, Script } from 'node:vm';
import { RESERVED_PREFIX } from './analyze-source.js';
import { compileSchema } from './compile-schema.js';
import { SCRIPT_BODY_PREFIX, wrapScriptBody } from './compile-script.js';
import { RUNTIME_GLOBAL_NAMES } from './contract.js';
import { readMetaObject } from './meta-statement.js';
import { PARSE_OPTIONS, parseSource } from './parse-source.js';
import { installRuntimeGlobals } from './runtime-globals.js';
import { findPosition, readPositionText } from './source-position.js';

/** @typedef {import('./runtime-globals.js').InstalledRuntime} InstalledRuntime */

/**
 * @typedef {object} Frame One place in the script that the stack of a thrown error names.
 * @property {number} line From 1, with a line break at LF and at a lone CR.
 * @property {number} column From 1.
 */

/**
 * @typedef {{ kind: 'returned', value: unknown } | { kind: 'threw', name: string, message: string, frames: Frame[] }
 *   | { kind: 'stopped' } | { kind: 'never-settles' }} SimulationEnd
 *   How the script ended. `value` is the JSON value the runtime reports for the return. `frames` lists the
 *   frames of the thrown error, newest first, and is [] for an end with no error of the script, such as the
 *   time limit, and for each case readFrames names. `stopped` when `answerCall` throws a SimulationStop before the script's promise settles.
 *   `never-settles` when the script waits on a promise that nothing settles, since no code can run, no
 *   answer is ready or pending and no timer is left.
 */

/**
 * @typedef {object} FrameSource What reads the call sites of a thrown value and places each in the script's text.
 * @property {CallSiteReader} callSiteReader
 * @property {import('node:vm').Context} context The script's context, which the read runs in.
 * @property {number} scriptTimeLimit The limit in milliseconds on the read, the script's own limit.
 * @property {string} text The entire script.
 * @property {number} metaEnd The offset just after the meta statement.
 */

/**
 * @typedef {object} ScriptEnding
 * @property {SimulationEnd} end A threw end of an error of the script lists no frame yet.
 * @property {{ value: unknown } | null} thrown The value the script threw, which the end's frames are read
 *   from, or null for an end with no error of the script.
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
 * @property {Readonly<GroupStamp> | null} parent The lane that invoked it, or null for an invocation outside
 *   every group.
 * @property {number} beforeCall The count of agent() calls made before it.
 */

/**
 * @typedef {object} Phase One phase() invocation.
 * @property {string} title `String` of the argument.
 * @property {number} beforeCall The count of agent() calls made before it.
 */

/**
 * @typedef {object} SimulationEvent One agent() call, phase() invocation or log line, in the order the
 *   script made them.
 * @property {'call' | 'phase' | 'log'} kind
 * @property {number} index For a call, the count of calls that `answerCall` got before it. For a phase or
 *   a log line, its index in `phases` or `logs`.
 */

/**
 * @typedef {object} AgentCall One agent() call, as `answerCall` gets it.
 * @property {unknown} prompt
 * @property {unknown} opts
 * @property {Readonly<GroupStamp> | null} group
 * @property {string | null} phase The title the runtime groups the call under, or null for none.
 */

/**
 * @typedef {object} SimulationOptions
 * @property {unknown} [args] A JSON value, or absent for no args.
 * @property {{ total?: number | null, spent?: number, spentPerCall?: number }} [budget]
 * @property {(call: AgentCall) => unknown} answerCall Gives the value of one agent() call, and the script
 *   gets a copy of it made as a list leaving parallel() is copied. A thrown error, or a promise it gives
 *   that rejects, rejects that call, and the script gets that error itself. A SimulationStop thrown or
 *   rejected that way leaves the call unsettled instead. It ends the simulation only before the script's
 *   promise settles. After that, the simulation goes on to its end.
 */

/**
 * @typedef {object} SimulationResult The part of a trace that the runtime stand-in records. It holds no
 *   call.
 * @property {SimulationEnd} end
 * @property {string[]} logs
 * @property {Phase[]} phases
 * @property {Group[]} groups In call order.
 * @property {SimulationEvent[]} events
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
// The texts Claude Code 2.1.332 gives for a return it cannot report.
const FUNCTION_RESULT_MESSAGE = 'workflow result cannot be a function';
const CYCLE_RESULT_MESSAGE = 'JSON.stringify cannot serialize cyclic structures.';
const BIGINT_RESULT_MESSAGE = 'JSON.stringify cannot serialize BigInt';
// Claude Code 2.1.332 names the compiled code so in a stack trace.
const SCRIPT_FILE_NAME = 'workflow.js';
const TIMEOUT_CODE = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
// Claude Code 2.1.332 refuses code generation from strings, and its global object holds no WebAssembly.
const CONTEXT_OPTIONS = Object.freeze({ codeGeneration: Object.freeze({ strings: false, wasm: false }) });
// The V8 default, so the --stack-trace-limit of the Node process that runs a simulation changes no frame.
// The runtime's limit was not measured.
const STACK_TRACE_LIMIT = 10;
// A vm timeout covers only a Script run, so a frames read runs as one, through a global set for that run alone.
const READ_GLOBAL_NAME = `${RESERVED_PREFIX}readCallSites`;
const READ_SCRIPT = new Script(`${READ_GLOBAL_NAME}()`);
const CYCLE = Symbol('cycle');
// The group index of a parallel() or pipeline() invocation after the simulation ended, which records none.
const NO_GROUP = -1;
const hasInstance = Function.prototype[Symbol.hasInstance];
const ignoreRejection = () => {};
// A context that runs no script reads no args and no budget.
const IDLE_SETTINGS = Object.freeze({ globalNames: RUNTIME_GLOBAL_NAMES, argsText: undefined, budgetTotal: null, budgetSpent: 0, budgetSpentPerCall: 0 });

/**
 * Ends a simulation at the agent() call whose `answerCall` throws it, so the script runs no further. The
 * `answerCall` doc of SimulationOptions says when a stop ends nothing.
 */
export class SimulationStop extends Error {
  constructor() {
    super('The simulation stopped at an agent() call');
    this.name = 'SimulationStop';
  }
}

/**
 * Runs a workflow script as the runtime of Claude Code 2.1.332 runs it, with no model call: each agent()
 * call gets what `answerCall` gives, once agent() has checked the call's schema. An answer reaches the
 * script only once the code the script queued before it has run, one answer per turn in the order the
 * answers are ready. Time is virtual. A timer runs once no other code of the script can run and no answer
 * is ready or pending, so a wait of any length ends at once. A timer callback that throws ends nothing, as
 * an unhandled rejection ends nothing, since the runtime's handling of it was not measured.
 * A thrown error's frames are read from its stack once the script's promise has settled and the simulation
 * has ended, so an error whose stack the script read before has none, and code of the script that the read
 * runs, such as a trap of a Proxy the script made its Error, records nothing. The read runs under the
 * script's time limit, and a read past it gives no frame.
 * Rejects when the text does not parse, does not open with the meta statement, or has a body that does not
 * compile. It checks no other rule of the contract, so a script the runtime refuses for another rule runs.
 * @param {string} text The entire script.
 * @param {SimulationOptions} options
 * @param {number} [scriptTimeLimit] The limit in milliseconds on the code before the first await, and on the
 *   frames read. Only a test passes it, to reach the limit fast.
 * @returns {Promise<SimulationResult>}
 */
export async function runSimulation(text, options, scriptTimeLimit = SCRIPT_TIME_LIMIT_MS) {
  const settings = readSettings(options);
  const metaEnd = readMetaEnd(text);
  const script = new Script(`${wrapScriptBody(text, metaEnd)}()`, { filename: SCRIPT_FILE_NAME });
  const { simulation, host } = createSimulation(options.answerCall);
  const { context, runtime, callSiteReader } = createScriptContext(host, settings);
  const frameSource = { callSiteReader, context, scriptTimeLimit, text, metaEnd };
  const stopIgnoringRejections = ignoreScriptRejections(runtime.ScriptPromise);
  const stopRecordingSettled = recordSettledPromises(simulation.settledPromises);
  let ending = null;
  let end = null;

  try {
    try {
      ending = await runScript(script, context, scriptTimeLimit, simulation, runtime);
    } finally {
      simulation.isActive = false;
      stopRecordingSettled();
    }
    end = ending.thrown === null ? ending.end : { ...ending.end, frames: readFrames(ending.thrown.value, frameSource) };
  } finally {
    // Code the script queued before it ended still runs, and may reject.
    await waitForIdle();
    stopIgnoringRejections();
  }

  return { end, logs: simulation.logs, phases: simulation.phases, groups: simulation.groups, events: simulation.events };
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
 * @returns {{ context: import('node:vm').Context, runtime: InstalledRuntime, callSiteReader: CallSiteReader }}
 */
function createScriptContext(host, settings) {
  const context = createContext(Object.create(null), CONTEXT_OPTIONS);
  const installRuntime = runInContext(`(${installRuntimeGlobals})`, context);
  const createReader = runInContext(`(${createCallSiteReader})`, context);

  runInContext('Error', context).stackTraceLimit = STACK_TRACE_LIMIT;
  return { context, runtime: installRuntime(host, settings), callSiteReader: createReader(SCRIPT_FILE_NAME, READ_GLOBAL_NAME) };
}

/**
 * @typedef {object} CallSiteReader The two steps around a read of a thrown value's call sites, each a
 *   function of the script's realm.
 * @property {(thrown: unknown, recordCompiledOffset: (compiledOffset: unknown) => void) => boolean} setRead
 *   Sets the read as a function of the script's global object under the read's global name. The read calls
 *   recordCompiledOffset with the offset into the compiled code of each call site of the thrown value in the
 *   script's file, newest first, and gives false when it could not be made or threw. setRead gives false for
 *   a value that is not an object and for a global object that refuses the name or already holds it.
 * @property {() => void} removeRead Removes the name that setRead set.
 */

/**
 * Gives the reader of a thrown value's call sites. Node 24.22.1 calls the prepareStackTrace of the Error
 * that the global object of an error's context holds, with the error's call sites, at the first read of
 * its stack, and never for an error a host function created. The read sets that hook for one read of the
 * stack and puts the script's own prepareStackTrace back after it.
 * The simulation compiles this function inside the script's context before the script runs. The read, the
 * hook, and each descriptor a trap of a Proxy the script made its Error receives, then belong to the
 * script's realm, whose Function refuses code from strings. For that reason it reads no name of this module.
 * It keeps each built-in it calls, and gives each descriptor it makes no prototype, since a script may
 * replace either.
 * @param {string} fileName The name the script is compiled under.
 * @param {string} readName The name of the global that holds the read while it runs.
 * @returns {CallSiteReader}
 */
function createCallSiteReader(fileName, readName) {
  'use strict';
  const scriptGlobal = globalThis;
  const { defineProperty, deleteProperty, getOwnPropertyDescriptor, setPrototypeOf } = Reflect;
  const HOOK_KEY = 'prepareStackTrace';
  const readCallSites = (thrown, recordCompiledOffset) => {
    let ScriptError = null;
    let original;
    let hookDescriptor = null;
    let isRead = true;
    const hook = (error, callSites) => {
      for (let index = 0; index < callSites.length; index += 1) {
        if (callSites[index].getFileName() === fileName) recordCompiledOffset(callSites[index].getPosition());
      }
    };

    try {
      ScriptError = scriptGlobal.Error;
      original = getOwnPropertyDescriptor(ScriptError, HOOK_KEY);
      if (original !== undefined) setPrototypeOf(original, null);
      // A partial descriptor keeps the attributes of the script's own property, so it can be put back.
      hookDescriptor = original === undefined ? { __proto__: null, value: hook, writable: true, configurable: true } : { __proto__: null, value: hook };
      if (!defineProperty(ScriptError, HOOK_KEY, hookDescriptor)) return false;
    } catch {
      return false;
    }
    try {
      thrown.stack;
    } catch {
      isRead = false;
    }
    try {
      if (original === undefined) deleteProperty(ScriptError, HOOK_KEY);
      else defineProperty(ScriptError, HOOK_KEY, original);
    } catch {
      // A trap of a Proxy the script made its Error may throw here, and the hook then stays set.
    }
    return isRead;
  };

  return {
    setRead: (thrown, recordCompiledOffset) => {
      if (thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')) return false;
      try {
        if (getOwnPropertyDescriptor(scriptGlobal, readName) !== undefined) return false;
        return defineProperty(scriptGlobal, readName, { __proto__: null, value: () => readCallSites(thrown, recordCompiledOffset), configurable: true });
      } catch {
        return false;
      }
    },
    removeRead: () => {
      deleteProperty(scriptGlobal, readName);
    },
  };
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
  if (!isBudgetTotal(budgetTotal)) throw new TypeError('options.budget.total must be null or a number of 0 or more');
  if (!isBudgetCount(budgetSpent)) throw new TypeError('options.budget.spent must be a finite number of 0 or more');
  if (!isBudgetCount(budgetSpentPerCall)) throw new TypeError('options.budget.spentPerCall must be a finite number of 0 or more');
  try {
    argsText = options.args === undefined ? undefined : JSON.stringify(options.args);
  } catch (error) {
    throw new TypeError(`options.args must be a JSON value. ${error.message}`, { cause: error });
  }
  if (options.args !== undefined && argsText === undefined) throw new TypeError('options.args must be a JSON value');
  return { globalNames: RUNTIME_GLOBAL_NAMES, argsText, budgetTotal, budgetSpent, budgetSpentPerCall };
}

/**
 * Infinity is allowed, as a total with no limit, and NaN is refused, since remaining() would give NaN.
 * @param {unknown} value
 * @returns {boolean} True for null or a number of 0 or more.
 */
export function isBudgetTotal(value) {
  return value === null || (typeof value === 'number' && value >= 0);
}

/**
 * Infinity is refused. An Infinity spent makes remaining() Infinity minus Infinity for an Infinity total, and an
 * Infinity spentPerCall makes spent() Infinity * 0 before the first answer, both NaN.
 * @param {unknown} value
 * @returns {boolean} True for a number that a budget can hold as spent, or add for each answered call.
 */
export function isBudgetCount(value) {
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
    /** @type {{ settle: () => void }[]} The answers that wait for a turn, in the order they are ready. */
    readyAnswers: [],
    /** @type {Set<Promise<void>>} */
    pendingAnswers: new Set(),
    runtimeErrors: new WeakSet(),
    /** @type {Map<string, import('./compile-schema.js').CompiledSchema>} Keyed by the JSON text of each schema. */
    compiledSchemas: new Map(),
    groupStore,
    /** @type {string[]} */
    logs: [],
    /** @type {Phase[]} */
    phases: [],
    /** @type {Group[]} */
    groups: [],
    /** @type {SimulationEvent[]} */
    events: [],
  };
  /** @type {import('./runtime-globals.js').RuntimeHost} */
  const host = {
    log: (line) => {
      if (!simulation.isActive) return;
      simulation.events.push({ kind: 'log', index: simulation.logs.push(line) - 1 });
    },
    phase: (title) => {
      if (!simulation.isActive) return;
      simulation.events.push({ kind: 'phase', index: simulation.phases.push({ title, beforeCall: simulation.callCount }) - 1 });
    },
    agent: (prompt, opts, resolve, reject) => answerAgentCall(simulation, answerCall, { prompt, opts, group: groupStore.getStore() ?? null }, resolve, reject),
    setTimeout: (callback, delay) => addTimer(simulation, callback, delay),
    clearTimeout: (id) => {
      simulation.timers.delete(id);
    },
    openGroup: (kind, items, stages) => {
      if (!simulation.isActive) return NO_GROUP;
      return simulation.groups.push({ kind, items, stages, parent: groupStore.getStore() ?? null, beforeCall: simulation.callCount }) - 1;
    },
    runInGroup: (group, item, stage, run) => groupStore.run(Object.freeze({ group, item, stage }), run),
    createRuntimeError: (name, message) => {
      const error = Object.assign(Object.create(null), { name, message });

      simulation.runtimeErrors.add(error);
      return error;
    },
    findSchemaRefusal: (schema) => findCompiledSchema(simulation.compiledSchemas, schema)?.refusal ?? null,
  };

  return { simulation, host };
}

/**
 * Compiles each distinct schema of one simulation once. Not measured: the runtime compiles a JSON copy of
 * the schema too. When it does not, a key whose value is `undefined` or a `toJSON` gives another outcome there.
 * @param {Map<string, import('./compile-schema.js').CompiledSchema>} compiledSchemas Keyed by the JSON text of each schema.
 * @param {object} schema A schema of the script's realm.
 * @returns {import('./compile-schema.js').CompiledSchema | null} Null for a schema with no JSON copy, such as
 *   one that holds a cycle, and for a compile that ran past a limit of the running Node, since the runtime's
 *   outcome for either was not measured.
 */
function findCompiledSchema(compiledSchemas, schema) {
  let schemaText;
  let compiled = null;

  // A getter or toJSON of the script may throw here, as JSON.stringify throws for a cycle or a BigInt.
  try {
    schemaText = JSON.stringify(schema);
  } catch {
    return null;
  }
  if (schemaText === undefined) return null;
  compiled = compiledSchemas.get(schemaText) ?? null;
  if (compiled !== null) return compiled;
  // A call from deep recursion may run out of stack here and not at a later call, so the RangeError is not kept.
  try {
    compiled = compileSchema(JSON.parse(schemaText));
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  compiledSchemas.set(schemaText, compiled);
  return compiled;
}

/**
 * Settles one agent() call with what `answerCall` gives, in a later turn than the call. A promise it gives
 * keeps the simulation waiting until it settles. No answer settles once the simulation has ended.
 * @param {ReturnType<typeof createSimulation>['simulation']} simulation
 * @param {SimulationOptions['answerCall']} answerCall
 * @param {Omit<AgentCall, 'phase'>} callArguments
 * @param {(value: unknown) => void} resolve
 * @param {(reason: unknown) => void} reject
 */
function answerAgentCall(simulation, answerCall, callArguments, resolve, reject) {
  let call = null;
  let answer;

  if (!simulation.isActive) return;
  call = { ...callArguments, phase: findCallPhase(callArguments.opts, simulation.phases) };
  simulation.events.push({ kind: 'call', index: simulation.callCount });
  simulation.callCount += 1;
  try {
    answer = answerCall(call);
  } catch (error) {
    rejectAgentCall(simulation, error, reject);
    return;
  }
  if (!isThenable(answer)) {
    addReadyAnswer(simulation, () => resolve(answer));
    return;
  }

  const settled = Promise.resolve(answer).then(
    (value) => addReadyAnswer(simulation, () => resolve(value)),
    (error) => {
      if (simulation.isActive) rejectAgentCall(simulation, error, reject);
    },
  );
  simulation.pendingAnswers.add(settled);
  settled.then(() => simulation.pendingAnswers.delete(settled));
}

/**
 * Gives a call its phase as the runtime of Claude Code 2.1.332 does, measured with two launched scripts:
 * the call's `phase` option, or else the title of the latest phase() invocation, from any group.
 * @param {unknown} opts The call's options, of the script's realm.
 * @param {Phase[]} phases The phase() invocations made before the call.
 * @returns {string | null}
 */
function findCallPhase(opts, phases) {
  const phaseOption = readPhaseOption(opts);

  if (phaseOption !== null) return phaseOption;
  return phases.length === 0 ? null : phases[phases.length - 1].title;
}

/**
 * Not measured: options that are not an object give no phase option, nor does an option whose read or
 * whose conversion with `String` throws.
 * @param {unknown} opts
 * @returns {string | null} `String` of the `phase` option, or null for an option of undefined or null.
 */
function readPhaseOption(opts) {
  let phaseOption;

  if (opts === null || typeof opts !== 'object') return null;
  try {
    phaseOption = opts.phase;
    return phaseOption === undefined || phaseOption === null ? null : String(phaseOption);
  } catch {
    return null;
  }
}

/**
 * @param {ReturnType<typeof createSimulation>['simulation']} simulation
 * @param {() => void} settleCall Settles one agent() call.
 */
function addReadyAnswer(simulation, settleCall) {
  // A subagent's answer needs a model call, so it cannot reach the script in the turn that made the call.
  // No runtime fixture measures this order.
  simulation.readyAnswers.push({
    settle: () => {
      if (simulation.isActive) settleCall();
    },
  });
}

/**
 * Rejects one agent() call with what `answerCall` threw, in a later turn than the call. A SimulationStop
 * leaves the call unsettled, and stops the simulation at once only before the script's promise settles.
 * @param {ReturnType<typeof createSimulation>['simulation']} simulation
 * @param {unknown} error
 * @param {(reason: unknown) => void} reject
 */
function rejectAgentCall(simulation, error, reject) {
  if (!(error instanceof SimulationStop)) {
    addReadyAnswer(simulation, () => reject(error));
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
 * @returns {Promise<ScriptEnding>}
 */
async function runScript(script, context, scriptTimeLimit, simulation, runtime) {
  let scriptPromise = null;

  try {
    scriptPromise = script.runInContext(context, { timeout: scriptTimeLimit });
  } catch (error) {
    if (error?.code !== TIMEOUT_CODE) throw error;
    if (simulation.isStopped) return endWithNoError({ kind: 'stopped' });
    return endWithNoError({ kind: 'threw', name: 'Error', message: TIMEOUT_MESSAGE, frames: [] });
  }
  simulation.scriptPromise = scriptPromise;

  const outcome = await settleScript(scriptPromise, simulation);

  if (simulation.isStopped) return endWithNoError({ kind: 'stopped' });
  if (outcome === null) return endWithNoError({ kind: 'never-settles' });
  if (outcome.isRejected) return convertThrown(outcome.value, simulation.runtimeErrors);
  return convertReturned(outcome.value, runtime.copyValue, simulation.runtimeErrors);
}

/**
 * @param {SimulationEnd} end
 * @returns {ScriptEnding}
 */
function endWithNoError(end) {
  return { end, thrown: null };
}

/**
 * Runs the script's queued code, then its ready answers one per turn, its pending answers and its timers,
 * until its promise settles.
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
    if (simulation.readyAnswers.length > 0) {
      simulation.readyAnswers.shift().settle();
    } else if (simulation.pendingAnswers.size > 0) {
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
 * @returns {ScriptEnding}
 */
function convertReturned(value, copyValue, runtimeErrors) {
  let copy;
  let hasBigInt = false;
  let json;

  if (typeof value === 'function') return endWithNoError({ kind: 'threw', name: 'Error', message: FUNCTION_RESULT_MESSAGE, frames: [] });
  try {
    copy = copyValue(value, () => CYCLE);
  } catch (error) {
    if (error === CYCLE) return endWithNoError({ kind: 'threw', name: 'TypeError', message: CYCLE_RESULT_MESSAGE, frames: [] });
    return convertThrown(error, runtimeErrors);
  }
  json = JSON.stringify(copy, (key, item) => {
    if (typeof item !== 'bigint') return item;
    hasBigInt = true;
    return null;
  });
  if (hasBigInt) return endWithNoError({ kind: 'threw', name: 'TypeError', message: BIGINT_RESULT_MESSAGE, frames: [] });
  return endWithNoError({ kind: 'returned', value: json === undefined ? null : JSON.parse(json) });
}

/**
 * An error, a runtime function's error included, gives its name and message. Any other value gives the
 * name Error and its message property, or the value as a string when it has none. The frames are read
 * after the name and the message, so a getter of either that reads the stack sees the stack unchanged.
 * @param {unknown} thrown
 * @param {WeakSet<object>} runtimeErrors
 * @returns {ScriptEnding}
 */
function convertThrown(thrown, runtimeErrors) {
  const isError = runtimeErrors.has(thrown) || readTag(thrown) === '[object Error]';
  const message = readField(thrown, 'message');
  const name = isError ? convertToText(readField(thrown, 'name')) : 'Error';
  const messageText = convertToText(isError || message !== undefined ? message : thrown);

  return { end: { kind: 'threw', name, message: messageText, frames: [] }, thrown: { value: thrown } };
}

/**
 * @param {unknown} thrown
 * @param {FrameSource} frameSource
 * @returns {Frame[]} Newest first. A call site outside the script's text after its meta statement, such as
 *   the place that invokes the wrapping function, gives no frame. [] for a value that is not an object, an error
 *   a runtime function throws, which has no stack, an error of the host realm, a stack read before or whose read
 *   throws, an Error whose prepareStackTrace cannot be set, such as a frozen one, a script that set
 *   Error.stackTraceLimit to 0, a global object that refuses the read's name, and a read that runs past the
 *   time limit.
 */
function readFrames(thrown, frameSource) {
  const { text, metaEnd } = frameSource;
  const compiledOffsets = [];
  // The script's code may call the hook with call sites of its own, so a compiled offset may be any value.
  const isRead = runCallSiteRead(thrown, frameSource, (compiledOffset) => {
    if (Number.isInteger(compiledOffset)) compiledOffsets.push(compiledOffset);
  });
  const offsets = isRead ? compiledOffsets.map((compiledOffset) => compiledOffset - SCRIPT_BODY_PREFIX.length + metaEnd).filter((offset) => offset >= metaEnd && offset < text.length) : [];

  if (offsets.length === 0) return [];

  const { positionText, markLength } = readPositionText(text);

  return offsets.map((offset) => findPosition(positionText, Math.max(0, offset - markLength)));
}

/**
 * Runs the read that setRead sets, as READ_SCRIPT in the script's context under the script's time limit.
 * @param {unknown} thrown
 * @param {FrameSource} frameSource
 * @param {(compiledOffset: unknown) => void} recordCompiledOffset
 * @returns {boolean} False when the read could not be made, threw or ran past the time limit.
 */
function runCallSiteRead(thrown, { callSiteReader, context, scriptTimeLimit }, recordCompiledOffset) {
  if (!callSiteReader.setRead(thrown, recordCompiledOffset)) return false;
  try {
    return READ_SCRIPT.runInContext(context, { timeout: scriptTimeLimit }) === true;
  } catch (error) {
    if (error?.code !== TIMEOUT_CODE) throw error;
    // The read stopped part way, so the hook may stay set on the script's Error, for code that records nothing.
    return false;
  } finally {
    callSiteReader.removeRead();
  }
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
