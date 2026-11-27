/**
 * @typedef {object} RuntimeHost The simulation's side of the runtime functions. The context calls these
 *   and reaches nothing else of the simulation, apart from the values and errors that `agent` settles with.
 * @property {(line: string) => void} log
 * @property {(title: string) => void} phase
 * @property {(prompt: unknown, opts: unknown, resolve: (value: unknown) => void, reject: (reason: unknown) => void) => void} agent
 * @property {(callback: unknown, delay: number) => number} setTimeout
 * @property {(id: unknown) => void} clearTimeout
 * @property {(kind: 'parallel' | 'pipeline', items: number, stages: number) => number} openGroup Gives the
 *   group's index, or -1 once the simulation has ended, since it then records no group.
 * @property {(group: number, item: number, stage: number, run: () => unknown) => unknown} runInGroup Calls
 *   `run` so that each agent() call it makes, and each call after an await of it, runs in that group.
 * @property {(name: string, message: string) => object} createRuntimeError
 */

/**
 * @typedef {object} RuntimeSettings
 * @property {readonly string[]} globalNames The only own names the global object may hold.
 * @property {string | undefined} argsText The args as JSON text, or undefined for no args.
 * @property {number | null} budgetTotal
 * @property {number} budgetSpent
 */

/**
 * @typedef {object} InstalledRuntime
 * @property {PromiseConstructor} ScriptPromise The Promise of the script's realm.
 * @property {(value: unknown, createCycleError: () => unknown) => unknown} copyValue Copies a value as a
 *   list leaving parallel() or pipeline() and an answer reaching agent() are copied, and throws what
 *   createCycleError gives for a cycle.
 */

/**
 * Gives the global object of the script's context the runtime's functions and no name the runtime lacks.
 * Each behavior is the one measured on Claude Code 2.1.332 unless a comment says it was not measured.
 * The simulation compiles this function inside that context from its source text, so each value it makes
 * belongs to the script's realm. For that reason it reads no name of this module. It keeps each built-in
 * it calls before the script runs, since a script may reassign a global.
 * @param {RuntimeHost} host
 * @param {RuntimeSettings} settings
 * @returns {InstalledRuntime}
 */
export function installRuntimeGlobals(host, settings) {
  'use strict';
  const ScriptPromise = Promise;
  const ScriptError = Error;
  const ScriptRangeError = RangeError;
  const ScriptString = String;
  const RealDate = Date;
  const { create: createObject, defineProperty, freeze, getOwnPropertyNames, keys: listKeys, setPrototypeOf } = Object;
  const { apply, construct } = Reflect;
  const describeObject = Object.prototype.toString;
  const isArray = Array.isArray;
  const parseJson = JSON.parse;
  const convertToNumber = Number;
  const findLarger = Math.max;

  const MAXIMUM_LIST_LENGTH = 4096;
  const CLOCK_MESSAGE = 'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.';
  const RANDOM_MESSAGE = 'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.';
  const THUNK_LIST_MESSAGE = 'parallel() expects an array of functions';
  const THUNK_MESSAGE = 'parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)';
  const ITEM_LIST_MESSAGE = 'pipeline() expects an array as the first argument';
  const STAGE_MESSAGE = 'pipeline() stages must be functions: pipeline(items, item => ..., result => ...)';
  const WORKFLOW_TARGET_MESSAGE = 'workflow() expects a workflow name (string) or {scriptPath: string}';
  const WORKFLOW_MESSAGE = 'workflow() is not simulated';
  const CYCLE_MESSAGE = 'Maximum call stack size exceeded.';
  // The runtime's texts for a schema it refuses before any agent starts.
  const SCHEMA_KIND_MESSAGE = 'WeakMap keys must be objects or non-registered symbols';
  const SCHEMA_INVALID_MESSAGE = 'agent({schema}) received an invalid JSON Schema: data must be object,boolean';
  const SCHEMA_UNUSABLE_MESSAGE = "agent({schema}) received an unusable JSON Schema — the API only accepts an object-rooted tool input schema, so every request would be rejected: the root schema must declare type: 'object' (the API rejects any other root type for a tool input schema); wrap arrays or primitives in an object property. The subagent was not started — fix the schema and call agent() again.";

  const convertToText = (value) => {
    try {
      return ScriptString(value);
    } catch {
      return apply(describeObject, value, []);
    }
  };
  const readFailure = (error) => {
    try {
      const isObject = error !== null && (typeof error === 'object' || typeof error === 'function');
      return convertToText(isObject && error.message !== undefined ? error.message : error);
    } catch {
      return convertToText(error);
    }
  };
  const formatLogLine = (value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || value === undefined || value === null) return ScriptString(value);
    return '[object]';
  };
  const defineMethod = (target, key, value) => {
    defineProperty(target, key, { value, writable: true, enumerable: false, configurable: true });
  };
  const throwRuntimeError = (name, message) => {
    throw host.createRuntimeError(name, message);
  };
  const createListCycleError = () => new ScriptRangeError(CYCLE_MESSAGE);

  const copyValue = (value, createCycleError) => {
    const ancestors = [];
    const copy = (item) => {
      if (typeof item === 'function') return undefined;
      if (item === null || typeof item !== 'object') return item;
      for (let index = 0; index < ancestors.length; index += 1) {
        if (ancestors[index] === item) throw createCycleError();
      }
      ancestors[ancestors.length] = item;
      const result = isArray(item) ? copyList(item) : copyRecord(item);
      ancestors.length -= 1;
      return result;
    };
    const copyList = (list) => {
      const result = [];
      for (let index = 0; index < list.length; index += 1) result[index] = copy(list[index]);
      return result;
    };
    // Each key is defined, so an own `__proto__` key stays a key and sets no prototype.
    const copyRecord = (record) => {
      const result = {};
      const recordKeys = listKeys(record);
      for (let index = 0; index < recordKeys.length; index += 1) {
        const field = record[recordKeys[index]];
        if (typeof field !== 'function') defineProperty(result, recordKeys[index], { value: copy(field), writable: true, enumerable: true, configurable: true });
      }
      return result;
    };
    return copy(value);
  };
  // Each run is already settled or settles to a value, so awaiting them in order waits for all of them.
  const awaitEach = async (runs) => {
    const results = [];
    for (let index = 0; index < runs.length; index += 1) results[index] = await runs[index];
    return results;
  };
  const checkListLength = (list) => {
    if (list.length > MAXIMUM_LIST_LENGTH) throwRuntimeError('Error', `array length ${list.length} exceeds the maximum of ${MAXIMUM_LIST_LENGTH} supported across the workflow VM boundary`);
  };

  const runThunk = async (thunk, group, item) => {
    // parallel() calls no thunk before it returns.
    await undefined;
    try {
      return await host.runInGroup(group, item, 0, thunk);
    } catch (error) {
      host.log(`parallel[${item}] failed: ${readFailure(error)}`);
      return null;
    }
  };
  const runParallel = async (thunks) => {
    if (!isArray(thunks)) throwRuntimeError('TypeError', THUNK_LIST_MESSAGE);
    checkListLength(thunks);
    for (let index = 0; index < thunks.length; index += 1) {
      if (typeof thunks[index] !== 'function') throwRuntimeError('TypeError', THUNK_MESSAGE);
    }
    const group = host.openGroup('parallel', thunks.length, 1);
    const runs = [];
    for (let item = 0; item < thunks.length; item += 1) runs[item] = runThunk(thunks[item], group, item);
    return copyValue(await awaitEach(runs), createListCycleError);
  };

  const runItem = async (item, index, stages, group) => {
    let value = item;
    // Not measured: pipeline() calls no stage before it returns, as parallel() calls no thunk.
    await undefined;
    for (let stage = 0; stage < stages.length; stage += 1) {
      const previous = value;
      try {
        value = await host.runInGroup(group, index, stage, () => apply(stages[stage], undefined, [previous, item, index]));
      } catch (error) {
        host.log(`pipeline[${index}] failed: ${readFailure(error)}`);
        return null;
      }
      if (value === null) return null;
    }
    return value;
  };
  const runPipeline = async (items, stages) => {
    if (!isArray(items)) throwRuntimeError('TypeError', ITEM_LIST_MESSAGE);
    checkListLength(items);
    for (let index = 0; index < stages.length; index += 1) {
      if (typeof stages[index] !== 'function') throwRuntimeError('TypeError', STAGE_MESSAGE);
    }
    const group = host.openGroup('pipeline', items.length, stages.length);
    const runs = [];
    for (let index = 0; index < items.length; index += 1) runs[index] = runItem(items[index], index, stages, group);
    return copyValue(await awaitEach(runs), createListCycleError);
  };

  // Options that are not an object, and a schema of null or undefined, give a call with no schema.
  const checkSchema = (opts) => {
    const schema = opts !== null && typeof opts === 'object' ? opts.schema : undefined;
    if (schema === undefined || schema === null) return;
    // Measured for a string. Not measured: a number, a boolean, a BigInt, a function or a symbol gets the same error.
    if (typeof schema !== 'object') throwRuntimeError('TypeError', SCHEMA_KIND_MESSAGE);
    if (isArray(schema)) throwRuntimeError('TelemetrySafeError', SCHEMA_INVALID_MESSAGE);
    if (schema.type !== 'object') throwRuntimeError('TelemetrySafeError', SCHEMA_UNUSABLE_MESSAGE);
  };
  // The script gets a copy of each answer, made of its own realm's objects. Not measured: an answer that holds a
  // cycle rejects as a list leaving parallel() that holds one does.
  const runAgent = (prompt, opts) => new ScriptPromise((resolve, reject) => {
    checkSchema(opts);
    const settleAnswer = (value) => {
      try {
        resolve(copyValue(value, createListCycleError));
      } catch (error) {
        reject(error);
      }
    };
    host.agent(prompt, opts, settleAnswer, reject);
  });

  const runWorkflow = async (target) => {
    const isName = typeof target === 'string';
    const isScriptPath = target !== null && typeof target === 'object' && typeof target.scriptPath === 'string';
    if (!isName && !isScriptPath) throwRuntimeError('TypeError', WORKFLOW_TARGET_MESSAGE);
    throwRuntimeError('Error', WORKFLOW_MESSAGE);
  };

  const { budgetTotal, budgetSpent } = settings;
  const budget = createObject(null);
  budget.total = budgetTotal;
  budget.spent = () => budgetSpent;
  budget.remaining = () => (budgetTotal === null ? Infinity : findLarger(0, budgetTotal - budgetSpent));

  const ScriptDate = function Date(...parts) {
    if (new.target === undefined || parts.length === 0) throw new ScriptError(CLOCK_MESSAGE);
    return construct(RealDate, parts, new.target);
  };
  // A date's constructor is the stand-in too, so no access path reaches the clock.
  ScriptDate.prototype = RealDate.prototype;
  defineMethod(ScriptDate, 'parse', RealDate.parse);
  defineMethod(ScriptDate, 'UTC', RealDate.UTC);
  defineMethod(ScriptDate, 'now', function now() {
    throw new ScriptError(CLOCK_MESSAGE);
  });
  RealDate.prototype.constructor = ScriptDate;

  setPrototypeOf(globalThis, Object.prototype);
  globalThis.Date = ScriptDate;
  Math.random = function random() {
    throw new ScriptError(RANDOM_MESSAGE);
  };
  // A function assigned to a property gets no name, which matches the runtime's empty function names.
  globalThis.agent = (...callArgs) => runAgent(callArgs[0], callArgs[1]);
  globalThis.parallel = (thunks) => runParallel(thunks);
  globalThis.pipeline = (items, ...stages) => runPipeline(items, stages);
  globalThis.workflow = (target) => runWorkflow(target);
  globalThis.phase = (title) => {
    host.phase(convertToText(title));
  };
  globalThis.log = (value) => {
    host.log(formatLogLine(value));
  };
  // Not measured: console.info, debug, error and warn record a line as console.log does.
  globalThis.console = {
    log: (value) => host.log(formatLogLine(value)),
    info: (value) => host.log(formatLogLine(value)),
    debug: (value) => host.log(formatLogLine(value)),
    error: (value) => host.log(formatLogLine(value)),
    warn: (value) => host.log(formatLogLine(value)),
  };
  globalThis.args = settings.argsText === undefined ? undefined : parseJson(settings.argsText);
  globalThis.budget = freeze(budget);
  globalThis.setTimeout = (callback, delay) => host.setTimeout(callback, delay === undefined ? 0 : convertToNumber(delay));
  globalThis.clearTimeout = (id) => {
    host.clearTimeout(id);
  };
  globalThis.then = undefined;
  globalThis.__wRg$loop = undefined;
  globalThis.__wRg$resolve = undefined;

  const keptNames = createObject(null);
  for (let index = 0; index < settings.globalNames.length; index += 1) keptNames[settings.globalNames[index]] = true;
  const ownNames = getOwnPropertyNames(globalThis);
  for (let index = 0; index < ownNames.length; index += 1) {
    if (keptNames[ownNames[index]] !== true) delete globalThis[ownNames[index]];
  }

  return { ScriptPromise, copyValue };
}
