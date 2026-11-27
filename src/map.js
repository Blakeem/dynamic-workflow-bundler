import { buildFlowGraph } from './build-flow-graph.js';
import { CONTRACT_RUNTIME_VERSION } from './contract.js';
import { isObject } from './is-object.js';
import { loadScenarios } from './load-scenarios.js';
import { PARSE_OPTIONS, parseSource } from './parse-source.js';
import { readMetaValue } from './read-meta-value.js';
import { readRoles } from './read-roles.js';
import { readThrowSites } from './read-throw-sites.js';
import { simulateFileScenario } from './simulate-file-scenario.js';
import { UsageError } from './usage-error.js';
import { checkScriptFile } from './validate.js';

/** @typedef {import('./build-flow-graph.js').FlowGraph} FlowGraph */
/** @typedef {import('./build-flow-graph.js').UnmappedScenario} UnmappedScenario */

// A misspelled key such as `scenario` would otherwise read as a missing scenarios file.
const MAP_OPTION_KEYS = new Set(['script', 'scenarios']);

/**
 * @typedef {object} MapOptions
 * @property {string} script The workflow script, as `validate()` takes it.
 * @property {string} scenarios The scenarios file, relative to the working directory or absolute.
 */

/**
 * @typedef {object} MapResult
 * @property {boolean} ok True when the graph holds the path of every scenario.
 * @property {string} script The script, as `validate()` names it.
 * @property {string} runtime The Claude Code version the simulations stand in for.
 * @property {FlowGraph | null} graph Null when a scenario is unmapped.
 * @property {UnmappedScenario[]} unmapped Each scenario the graph cannot hold, in file order.
 */

/**
 * Simulates every scenario of a scenarios file against one workflow script and folds the traces into one
 * graph of every path they reach, and writes and prints nothing.
 * Rejects with a UsageError for options of another shape, and for each problem that `loadScenarios()` and
 * `simulate()` reject for. A rejection of `simulate()` names the scenario and the scenarios file.
 * @param {MapOptions} options
 * @returns {Promise<MapResult>}
 */
export async function map(options = /** @type {MapOptions} */ ({})) {
  const { script, scenarios } = readOptions(options);
  const fileScenarios = await loadScenarios(scenarios);
  const { scriptPath, text, findings } = await checkScriptFile(script);
  // A refused script does not run, so each of its scenarios is unmapped and no reader needs its tree.
  const scriptShape = findings.length === 0 ? readScriptShape(/** @type {string} */ (text)) : { roles: [], throwSites: [], phases: [] };
  const simulations = [];

  for (const fileScenario of fileScenarios) {
    const { name, when, endState } = fileScenario;

    simulations.push({ name, when, endState, trace: await simulateFileScenario(script, fileScenario, scenarios) });
  }
  const { graph, unmapped } = buildFlowGraph({ ...scriptShape, runs: simulations });

  return { ok: unmapped.length === 0, script: scriptPath, runtime: CONTRACT_RUNTIME_VERSION, graph, unmapped };
}

/**
 * @param {unknown} options
 * @returns {MapOptions}
 */
function readOptions(options) {
  if (!isObject(options)) throw new UsageError('map() takes an options object');
  const unknownKey = Object.keys(options).find((key) => !MAP_OPTION_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`map() takes no option ${unknownKey}`);
  const { script, scenarios } = options;
  if (typeof script !== 'string' || script === '') throw new UsageError('map() needs script, the path of a workflow script');
  if (typeof scenarios !== 'string' || scenarios === '') throw new UsageError('map() needs scenarios, the path of a scenarios file');
  return { script, scenarios };
}

/**
 * @param {string} text A script that breaks no rule of the contract, so it parses.
 * @returns {{ roles: string[], throwSites: import('./read-throw-sites.js').ThrowSite[], phases: unknown[] }}
 */
function readScriptShape(text) {
  const program = parseSource(text, PARSE_OPTIONS);
  const meta = readMetaValue(program);

  return { roles: readRoles(program), throwSites: readThrowSites(program, text), phases: Array.isArray(meta?.phases) ? meta.phases : [] };
}
