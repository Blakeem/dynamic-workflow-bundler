import { CONTRACT_RUNTIME_VERSION } from './contract.js';
import { findFreeNames } from './find-free-names.js';
import { findNonJsonValue, isPlainObject } from './find-non-json-value.js';
import { findScriptedReturn, formatCallName } from './find-scripted-return.js';
import { formatErrorCause } from './format-error-cause.js';
import { PARSE_OPTIONS, parseSource } from './parse-source.js';
import { convertToText, listMissingGlobalNames, runSimulation, SimulationStop } from './run-simulation.js';
import { UsageError } from './usage-error.js';
import { checkScriptFile } from './validate.js';

/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./run-simulation.js').AgentCall} AgentCall */

// A misspelled key such as `scenarios` would otherwise read as a missing scenario.
const SIMULATE_OPTION_KEYS = new Set(['script', 'scenario']);
const SCENARIO_KEYS = new Set(['name', 'args', 'respond', 'budget']);
const BUDGET_KEYS = new Set(['total', 'spent']);

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
 * @property {{ total?: number | null, spent?: number }} [budget]
 */

/**
 * @typedef {object} TraceCall One agent() call, in call order.
 * @property {number} index From 0.
 * @property {string | null} label `opts.label` when it is a string.
 * @property {string} prompt
 * @property {unknown} opts A JSON copy of the options without functions, or null for no options or for
 *   options JSON cannot hold, such as options with a cycle or a BigInt.
 * @property {import('./run-simulation.js').GroupStamp | null} group
 * @property {ScriptedReturn} [returned] The scripted return the script got, absent for the call the
 *   simulation stopped at.
 */

/**
 * @typedef {Exclude<import('./run-simulation.js').SimulationEnd, { kind: 'stopped' }>
 *   | { kind: 'stopped', reason: 'unanswered' | 'wrong-type' | 'not-json', message: string, call: number }
 *   | { kind: 'stopped', reason: 'node-lacks-name', message: string }
 *   | { kind: 'refused', findings: Finding[] }} TraceEnd How the simulation ended. A stop's message has
 *   no closing period. `call` is the index of the call that got no usable scripted return.
 */

/**
 * @typedef {object} Trace The record of one simulation, made of JSON values only.
 * @property {string} script The script, as `validate()` names it.
 * @property {string | null} scenario The scenario's name.
 * @property {string} runtime The Claude Code version the simulation stands in for.
 * @property {TraceEnd} end
 * @property {TraceCall[]} calls
 * @property {import('./run-simulation.js').Group[]} groups
 * @property {import('./run-simulation.js').Phase[]} phases
 * @property {string[]} logs
 */

/**
 * Runs a workflow script against a scenario with no model call, and writes and prints nothing. Each agent()
 * call gets the scripted return that the scenario's respond gives it, and the simulation stops at a call
 * that gets none it can use. A script that breaks the contract is refused and does not run, and a script
 * larger than READ_BYTE_LIMIT is refused as `validate()` refuses it.
 * Not simulated: the check of `agentType` and `model` against the session, any check of a schema other
 * than its root type, the limit on agent calls, and a budget that grows as agents run.
 * Rejects with a UsageError for options or a scenario of another shape, for a script `validate()` rejects,
 * and for a respond function that throws at a call made before the script settles.
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
  // runSimulation ignores a stop at a call made after the script settled, so its record is dropped too.
  const isStopped = result.end.kind === 'stopped';

  if (isStopped && recorder.stop.end === null) throw await createRespondFailure(recorder.stop.call, recorder.stop.respondError);
  return {
    ...traceHead,
    end: isStopped ? recorder.stop.end : result.end,
    calls: isStopped ? [...recorder.calls, recorder.stop.call] : recorder.calls,
    groups: result.groups,
    phases: result.phases,
    logs: result.logs,
  };
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
 * @param {unknown} scenario
 */
function checkScenario(scenario) {
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
  if (!isObject(budget)) throw new UsageError('The scenario budget must be an object of total and spent');
  const unknownKey = Object.keys(budget).find((key) => !BUDGET_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`The scenario budget takes no key ${unknownKey}`);
  const { total, spent } = budget;
  if (total !== undefined && total !== null && typeof total !== 'number') throw new UsageError('The scenario budget total must be a number or null');
  if (spent !== undefined && typeof spent !== 'number') throw new UsageError('The scenario budget spent must be a number');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>} True for an object that is not null and not an array.
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return { ...traceHead, end, calls: [], groups: [], phases: [], logs: [] };
}

/**
 * @typedef {object} CallStop The call that stopped the simulation, kept apart from the answered calls.
 * @property {Omit<TraceCall, 'returned'>} call
 * @property {TraceEnd | null} end Null when the respond function threw.
 * @property {unknown} respondError What the respond function threw, when `end` is null.
 */

/**
 * Answers each agent() call from `respond` and records it. A call that gets no usable scripted return, or
 * whose respond function throws, stops the simulation.
 * @param {Respond | undefined} respond
 */
function createCallRecorder(respond) {
  const recorder = {
    /** @type {TraceCall[]} The calls that got a scripted return. */
    calls: [],
    /** @type {CallStop | null} The latest stop, which a call after the script settled may give. */
    stop: null,
    /** @param {AgentCall} agentCall */
    answerCall: (agentCall) => {
      const call = convertCall(agentCall, recorder.calls.length);
      let outcome = null;

      try {
        outcome = findScriptedReturn(respond, call, recorder.calls, hasSchemaObject(agentCall.opts));
      } catch (error) {
        recorder.stop = { call, end: null, respondError: error };
        throw new SimulationStop();
      }
      if (outcome.kind === 'stopped') {
        recorder.stop = { call, end: { kind: 'stopped', reason: outcome.reason, message: outcome.message, call: call.index }, respondError: null };
        throw new SimulationStop();
      }
      recorder.calls.push({ ...call, returned: outcome.returned });
      return outcome.returned;
    },
  };

  return recorder;
}

/**
 * @param {AgentCall} agentCall Values of the script's realm.
 * @param {number} index
 * @returns {Omit<TraceCall, 'returned'>}
 */
function convertCall(agentCall, index) {
  const { prompt, opts, group } = agentCall;
  const label = isScriptObject(opts) && typeof opts.label === 'string' ? opts.label : null;

  return {
    index,
    label,
    prompt: convertToText(prompt),
    opts: copyOptions(opts),
    group: group === null ? null : { group: group.group, item: group.item, stage: group.stage },
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
 * agent() threw for every other schema before it called answerCall.
 * @param {unknown} opts
 * @returns {boolean} True when the options pass a schema object.
 */
function hasSchemaObject(opts) {
  return isScriptObject(opts) && isScriptObject(opts.schema);
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
