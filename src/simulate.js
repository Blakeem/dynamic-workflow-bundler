import { AGENT_CALL_LIMIT, CONTRACT_RUNTIME_VERSION, isPastCallLimit } from './contract.js';
import { findFreeNames } from './find-free-names.js';
import { findNonJsonValue, isPlainObject } from './find-non-json-value.js';
import { findScriptedReturn, formatCallName } from './find-scripted-return.js';
import { formatErrorCause } from './format-error-cause.js';
import { isObject } from './is-object.js';
import { PARSE_OPTIONS, parseSource } from './parse-source.js';
import { convertToText, isBudgetCount, isBudgetTotal, listMissingGlobalNames, runSimulation, SimulationStop } from './run-simulation.js';
import { UsageError } from './usage-error.js';
import { checkScriptFile } from './validate.js';

/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./run-simulation.js').AgentCall} AgentCall */

// A misspelled key such as `scenarios` would otherwise read as a missing scenario.
export const SIMULATE_OPTION_KEYS = new Set(['script', 'scenario']);
export const SCENARIO_KEYS = new Set(['name', 'args', 'respond', 'budget']);
const BUDGET_KEYS = new Set(['total', 'spent', 'spentPerCall']);
// A run of such a script on Claude Code 2.1.332 did not end while it was watched, and no runtime fixture
// records an end, so the simulation stops rather than report one.
const NEVER_SETTLES_MESSAGE = 'The script waits on a promise that nothing settles. A run of this script would not end';

/**
 * @typedef {string | Record<string, unknown> | null} ScriptedReturn What one agent() call gets: a string for
 *   a call with no schema, a plain JSON object for a call with a schema, or null for an agent that died.
 */

/**
 * @typedef {(call: Omit<TraceCall, 'returned'>, earlierCalls: TraceCall[]) => unknown} RespondFunction Gives
 *   the scripted return of one call.
 */

/**
 * @typedef {RespondFunction | Record<string, unknown>} Respond A function, or an object keyed by label
 *   prefix whose values are each a scripted return, a list of scripted returns or a RespondFunction.
 */

/**
 * @typedef {object} Scenario
 * @property {string} [name]
 * @property {unknown} [args] A JSON value, or absent for no args.
 * @property {Respond} [respond] Absent answers no call.
 * @property {{ total?: number | null, spent?: number, spentPerCall?: number }} [budget]
 */

/**
 * @typedef {object} TraceCall One agent() call, in call order.
 * @property {number} index From 0.
 * @property {string | null} label `opts.label` when it is a string.
 * @property {string} prompt
 * @property {unknown} opts A JSON copy of the options without functions, or null for no options or for
 *   options JSON cannot hold, such as options with a cycle or a BigInt.
 * @property {import('./run-simulation.js').GroupStamp | null} group
 * @property {string | null} phase The title the runtime groups the call under, or null for none.
 * @property {ScriptedReturn} [returned] The scripted return the script got. Absent for the call the
 *   simulation stopped at, and for a call made after the script settled that got no usable scripted return
 *   or came after the AGENT_CALL_LIMIT calls. The simulation does not stop at such a call, since the runtime
 *   of Claude Code 2.1.332 reports a call made after the script settled. That was measured for a call under
 *   the cap, and a call past the cap follows the same rule unmeasured.
 */

/**
 * @typedef {Exclude<import('./run-simulation.js').SimulationEnd, { kind: 'stopped' } | { kind: 'never-settles' }>
 *   | { kind: 'stopped', reason: 'unanswered' | 'wrong-type' | 'not-json' | 'breaks-schema' | 'check-out-of-stack' | 'call-limit', message: string, call: number }
 *   | { kind: 'stopped', reason: 'node-lacks-name' | 'never-settles', message: string }
 *   | { kind: 'refused', findings: Finding[] }} TraceEnd How the simulation ended. A `threw` end's `frames`
 *   are as runSimulation gives them. A stop's message has no closing period. `call` is the index of the call
 *   the simulation stopped at.
 */

/**
 * @typedef {object} Trace The record of one simulation, made of JSON values only.
 * @property {string} script The script, as `validate()` names it.
 * @property {string | null} scenario The scenario's name.
 * @property {string} runtime The Claude Code version the simulation stands in for.
 * @property {TraceEnd} end
 * @property {TraceCall[]} calls
 * @property {import('./run-simulation.js').Group[]} groups Each `beforeCall` counts only the calls of
 *   `calls`.
 * @property {import('./run-simulation.js').Phase[]} phases Each `beforeCall` counts only the calls of
 *   `calls`.
 * @property {string[]} logs
 * @property {TraceEvent[]} events One event per element of `calls`, `phases` and `logs`, in the order the
 *   script made them, a call made after the script settled included. A call that the argument check of
 *   agent() rejects is not in `calls` and has no event, although the runtime reports it. A script that did
 *   not run has none.
 */

/**
 * @typedef {object} TraceEvent
 * @property {'call' | 'phase' | 'log'} kind
 * @property {number} index The index in `calls`, `phases` or `logs`.
 */

/**
 * Runs a workflow script against a scenario with no model call, and writes and prints nothing. Each agent()
 * call gets the scripted return that the scenario's respond gives it, and the simulation stops at a call
 * that gets none it can use, at the call after the AGENT_CALL_LIMIT calls the runtime allows one workflow,
 * or when the script waits on a promise that nothing settles. A script that breaks the contract is refused
 * and does not run, and a script larger than READ_BYTE_LIMIT is refused as `validate()` refuses it.
 * agent() throws the runtime's error for a schema that holds a keyword JSON Schema draft-07 does not define,
 * with `$defs`, `deprecated` and `nullable` beside a `type` among the keywords taken beside the draft-07
 * keywords, a keyword whose value has the wrong form, a `$ref` that names no place in the schema, a `$schema`
 * other than draft-07, or a root `type` other than `'object'`. A `format` is taken and not checked. For a
 * `pattern` that is no regular expression, the text of the error differs from the runtime's, since the
 * JavaScript engine words it. A schema that is `false`, `0`, `''` or a function gives a call with no schema.
 * agent() checks a JSON copy of the schema, and a schema with no JSON copy gets only the check of its root
 * `type`. So does a call whose compile runs out of stack, such as for a schema nested a few hundred levels deep.
 * A scripted return object for a call with a schema is checked against that schema as the runtime checks an
 * agent's output, and one that breaks it stops the simulation, since the runtime never gives the script such
 * an object. An object whose check against the schema runs out of stack also stops it, such as for a schema
 * whose `$ref` leads back to itself with no key between or an object nested too deep, since the simulator
 * cannot tell whether it passes. A key the schema does not list passes unless a keyword of the schema rules it out, such as
 * `additionalProperties` set to `false` or to a schema the key's value breaks, and a `default` is not filled
 * in. A schema with no JSON copy, a schema with a truthy `$async`, or a schema whose compile ran out of stack
 * checks no return.
 * Not simulated: the check of `agentType` and `model` against the session, the cap of 5 rejected outputs of
 * one agent after which agent() throws on the runtime, and a budget that grows by a different count at each call.
 * The `stack` text of an error may name files and lines of the simulator on this machine, so a script that
 * logs a stack or puts one in a prompt gets output that differs between machines.
 * A call of `workflow()` that names a workflow throws an Error with the message
 * `workflow() is not simulated`. Time is virtual, so each `agent()` call answers before any timer runs and
 * a wait of any length ends at once. Code after a script's first `await` has no time limit. So a loop
 * there with no end keeps the simulation from ending, unless it calls `agent()` and waits for an `agent()`
 * answer or a timer between those calls, since the simulation then stops at the cap on `agent()` calls.
 * A wait for a promise that settles at once, such as `await null`, does not count.
 * A call made after the script settled that gets no usable scripted return or comes after the
 * AGENT_CALL_LIMIT calls stops nothing, and its record has no `returned` key.
 * A `threw` end holds `frames`, which the TraceEnd typedef describes.
 * Rejects with a UsageError for options or a scenario of another shape, for a script `validate()` rejects,
 * and for a respond function that throws at a call, before or after the script settles.
 * @param {{ script: string, scenario?: Scenario }} options `script` as `validate()` takes it.
 * @returns {Promise<Trace>}
 */
export async function simulate(options = /** @type {{ script: string }} */ ({})) {
  const { script, scenario } = readOptions(options);
  const { scriptPath, text, findings } = await checkScriptFile(script);
  const traceHead = { script: scriptPath, scenario: scenario.name ?? null, runtime: CONTRACT_RUNTIME_VERSION };

  if (findings.length > 0) return createTraceWithoutRun(traceHead, { kind: 'refused', findings });

  const lackedName = findLackedName(text);

  if (lackedName !== null) return createTraceWithoutRun(traceHead, { kind: 'stopped', reason: 'node-lacks-name', message: formatLackedNameMessage(lackedName) });

  const recorder = createCallRecorder(scenario.respond);
  const result = await runSimulation(text, { args: scenario.args, budget: scenario.budget, answerCall: recorder.answerCall });

  if (recorder.respondFailure !== null) throw await createRespondFailure(recorder.respondFailure.call, recorder.respondFailure.error);

  const droppedCalls = recorder.rejectedCalls;
  const events = convertEvents(result.events, droppedCalls);

  return {
    ...traceHead,
    // runSimulation ignores a stop at a call made after the script settled, so only a stop before it ends the trace.
    end: result.end.kind === 'stopped' ? /** @type {TraceEnd} */ (recorder.stopEnd) : convertRunEnd(result.end),
    calls: recorder.calls,
    groups: result.groups.map((group) => ({ ...group, parent: copyGroupStamp(group.parent), beforeCall: countTraceCalls(group.beforeCall, droppedCalls) })),
    phases: result.phases.map((phase) => ({ ...phase, beforeCall: countTraceCalls(phase.beforeCall, droppedCalls) })),
    logs: result.logs,
    events,
  };
}

/**
 * Gives each call event the index of its call in the trace, and drops the event of each call the trace
 * drops.
 * @param {import('./run-simulation.js').SimulationEvent[]} simulationEvents
 * @param {Set<number>} droppedCalls The index of each dropped call among the calls `answerCall` got.
 * @returns {TraceEvent[]}
 */
function convertEvents(simulationEvents, droppedCalls) {
  const events = [];
  let callCount = 0;

  for (const event of simulationEvents) {
    if (event.kind === 'call' && droppedCalls.has(event.index)) continue;
    if (event.kind === 'call') {
      events.push({ kind: 'call', index: callCount });
      callCount += 1;
      continue;
    }
    events.push({ kind: event.kind, index: event.index });
  }
  return events;
}

/**
 * @param {number} beforeCall The count of the calls `answerCall` got before a phase or a group.
 * @param {Set<number>} droppedCalls The index of each dropped call among those calls.
 * @returns {number} The count of the trace's calls before that phase or group.
 */
function countTraceCalls(beforeCall, droppedCalls) {
  let droppedBefore = 0;

  for (const index of droppedCalls) {
    if (index < beforeCall) droppedBefore += 1;
  }
  return beforeCall - droppedBefore;
}

/**
 * @param {Readonly<import('./run-simulation.js').GroupStamp> | null} stamp A stamp of the simulation.
 * @returns {import('./run-simulation.js').GroupStamp | null} A copy of the stamp for the trace.
 */
function copyGroupStamp(stamp) {
  return stamp === null ? null : { group: stamp.group, item: stamp.item, stage: stamp.stage };
}

/**
 * @param {Exclude<import('./run-simulation.js').SimulationEnd, { kind: 'stopped' }>} end
 * @returns {TraceEnd}
 */
function convertRunEnd(end) {
  if (end.kind === 'never-settles') return { kind: 'stopped', reason: 'never-settles', message: NEVER_SETTLES_MESSAGE };
  return end;
}

/**
 * @param {unknown} options
 * @returns {{ script: string, scenario: Scenario }}
 */
function readOptions(options) {
  if (!isObject(options)) throw new UsageError('simulate() takes an options object');
  const unknownKey = Object.keys(options).find((key) => !SIMULATE_OPTION_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`simulate() takes no option ${unknownKey}`);
  const { script, scenario = {} } = options;
  if (typeof script !== 'string' || script === '') throw new UsageError('simulate() needs script, the path of a workflow script');
  checkScenario(scenario);
  return { script, scenario };
}

/**
 * Throws a UsageError for a scenario that simulate() rejects.
 * @param {unknown} scenario
 */
export function checkScenario(scenario) {
  if (!isObject(scenario)) throw new UsageError('simulate() takes scenario, an object of name, args, respond and budget');
  const unknownKey = Object.keys(scenario).find((key) => !SCENARIO_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`The scenario takes no key ${unknownKey}`);
  const { name, args, respond, budget } = scenario;
  if (name !== undefined && typeof name !== 'string') throw new UsageError('The scenario name must be a string');
  if (args !== undefined) checkArgs(args);
  // A Map would answer no call, since only an object's own keys are read.
  if (respond !== undefined && typeof respond !== 'function' && !(isObject(respond) && isPlainObject(respond))) throw new UsageError('The scenario respond must be an object keyed by label prefix, or a function');
  if (budget !== undefined) checkBudget(budget);
}

/**
 * @param {unknown} args Not undefined.
 */
function checkArgs(args) {
  const nonJson = findNonJsonValue(args);

  if (nonJson === null) return;
  if (nonJson.path === '') throw new UsageError(`The scenario args are ${nonJson.kind}, which JSON cannot carry`);
  throw new UsageError(`The scenario args hold ${nonJson.kind} at ${nonJson.path}, which JSON cannot carry`);
}

/**
 * @param {unknown} budget Not undefined.
 */
function checkBudget(budget) {
  if (!isObject(budget)) throw new UsageError('The scenario budget must be an object of total, spent and spentPerCall');
  const unknownKey = Object.keys(budget).find((key) => !BUDGET_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`The scenario budget takes no key ${unknownKey}`);
  const { total, spent, spentPerCall } = budget;
  if (total !== undefined && !isBudgetTotal(total)) throw new UsageError('The scenario budget total must be null or a number of 0 or more');
  if (spent !== undefined && !isBudgetCount(spent)) throw new UsageError('The scenario budget spent must be a finite number of 0 or more');
  if (spentPerCall !== undefined && !isBudgetCount(spentPerCall)) throw new UsageError('The scenario budget spentPerCall must be a finite number of 0 or more');
}

/**
 * @param {string} text A script that breaks no rule of the contract, so it parses.
 * @returns {string | null} The first name the script reads that the runtime defines and the simulation's
 *   global object lacks, or null.
 */
function findLackedName(text) {
  const missingNames = new Set(listMissingGlobalNames());
  const lackedNode = findFreeNames(parseSource(text, PARSE_OPTIONS)).find((identifier) => missingNames.has(identifier.name));

  return lackedNode === undefined ? null : lackedNode.name;
}

/**
 * @param {string} name
 * @returns {string}
 */
function formatLackedNameMessage(name) {
  return `The script reads ${name}, which the runtime defines and Node ${process.version} does not, so the simulation cannot run it. Run it on a Node that defines ${name}`;
}

/**
 * @param {{ script: string, scenario: string | null, runtime: string }} traceHead
 * @param {TraceEnd} end
 * @returns {Trace}
 */
function createTraceWithoutRun(traceHead, end) {
  return { ...traceHead, end, calls: [], groups: [], phases: [], logs: [], events: [] };
}

/**
 * @typedef {object} RespondFailure The first call whose respond function threw.
 * @property {Omit<TraceCall, 'returned'>} call
 * @property {unknown} error What the respond function threw.
 */

/**
 * Answers each agent() call from `respond` and records it. A call after AGENT_CALL_LIMIT earlier calls, a
 * call that gets no usable scripted return, and a call whose respond function throws each throw a
 * SimulationStop and are recorded with no `returned` key. The stop ends the simulation only before the
 * script's promise settles.
 * @param {Respond | undefined} respond
 */
function createCallRecorder(respond) {
  const recorder = {
    /** @type {TraceCall[]} The calls of the trace, in call order. */
    calls: [],
    /** @type {TraceEnd | null} The end of the latest stop, which a call after the script settled may give. */
    stopEnd: null,
    /** @type {RespondFailure | null} */
    respondFailure: null,
    /** The count of calls answerCall got. */
    receivedCount: 0,
    /** @type {Set<number>} The index among those calls of each call rejected for options it cannot read. */
    rejectedCalls: new Set(),
    /** @param {AgentCall} agentCall */
    answerCall: (agentCall) => {
      const receivedIndex = recorder.receivedCount;
      let call = null;
      let outcome = null;

      recorder.receivedCount += 1;
      try {
        call = convertCall(agentCall, recorder.calls.length);
      } catch (error) {
        recorder.rejectedCalls.add(receivedIndex);
        throw error;
      }
      try {
        outcome = findCallOutcome(respond, call, recorder.calls, agentCall.schema);
      } catch (error) {
        recorder.respondFailure ??= { call, error };
        recorder.calls.push(call);
        throw new SimulationStop();
      }
      if (outcome.kind === 'stopped') {
        recorder.stopEnd = { kind: 'stopped', reason: outcome.reason, message: outcome.message, call: call.index };
        recorder.calls.push(call);
        throw new SimulationStop();
      }
      recorder.calls.push({ ...call, returned: outcome.returned });
      return outcome.returned;
    },
  };

  return recorder;
}

/**
 * @param {Respond | undefined} respond
 * @param {Omit<TraceCall, 'returned'>} call
 * @param {TraceCall[]} earlierCalls The earlier calls of the trace.
 * @param {AgentCall['schema']} schema
 * @returns {import('./find-scripted-return.js').ScriptedReturnResult | { kind: 'stopped', reason: 'call-limit', message: string }}
 *   A stop for a call past the cap, which reads no respond, or the scripted return of the call.
 */
function findCallOutcome(respond, call, earlierCalls, schema) {
  if (isPastCallLimit(call.index)) return { kind: 'stopped', reason: 'call-limit', message: formatCallLimitMessage(call) };
  return findScriptedReturn(respond, call, earlierCalls, schema);
}

/**
 * @param {Omit<TraceCall, 'returned'>} call
 * @returns {string}
 */
function formatCallLimitMessage(call) {
  return `The script made more than ${AGENT_CALL_LIMIT} agent() calls, the cap the runtime puts on one workflow. Check the code that makes ${formatCallName(call)}`;
}

/**
 * @param {AgentCall} agentCall Values of the script's realm.
 * @param {number} index
 * @returns {Omit<TraceCall, 'returned'>}
 */
function convertCall(agentCall, index) {
  const { prompt, opts, group, phase } = agentCall;
  const label = isScriptObject(opts) && typeof opts.label === 'string' ? opts.label : null;

  return {
    index,
    label,
    prompt: convertToText(prompt),
    opts: copyOptions(opts),
    group: copyGroupStamp(group),
    phase,
  };
}

/**
 * @param {unknown} opts
 * @returns {unknown} The JSON copy, or null when JSON gives no text for the options or cannot hold them.
 */
function copyOptions(opts) {
  try {
    const text = JSON.stringify(opts);
    return text === undefined ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isScriptObject(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * @param {Omit<TraceCall, 'returned'>} call
 * @param {unknown} error What the respond function threw.
 * @returns {Promise<UsageError>}
 */
async function createRespondFailure(call, error) {
  const failure = new UsageError(`The scenario's respond threw at ${formatCallName(call)}. ${await formatErrorCause(error)}`);

  failure.cause = error;
  return failure;
}
