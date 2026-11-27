import { dirname, resolve } from 'node:path';
import { isFolderPath } from './display-path.js';
import { isObject } from './is-object.js';
import { UsageError } from './usage-error.js';

const CONFIG_KEYS = new Set(['workflows']);
const WORKFLOW_KEYS = new Set(['entry', 'out', 'banner', 'validate', 'scenarios', 'map']);
// The words each message gives a path field of a workflow, in the order a map path is compared with them.
const MAP_CONFLICT_FIELDS = Object.freeze([
  ['entry', 'entry'],
  ['out', 'out file'],
  ['scenarios', 'scenarios file'],
  ['map', 'map'],
]);

/**
 * @typedef {object} ConfigWorkflow
 * @property {string} entry The entry file's absolute path.
 * @property {string} out The built script's absolute path.
 * @property {boolean} banner Defaults to true.
 * @property {boolean} validate Whether the build, and `dwfb validate` with no script, check the built script
 *   against the contract. Defaults to true.
 * @property {string | null} scenarios The absolute path of the scenarios file that `dwfb simulate`,
 *   `dwfb inspect` and `dwfb map` run `out` against, or null for a workflow that `dwfb simulate` with no script
 *   skips.
 * @property {string | null} map The absolute path of the flow map that `dwfb map` writes for `out`, or null for
 *   a workflow that `dwfb map` with no script skips.
 */

/**
 * @typedef {object} Config
 * @property {ConfigWorkflow[]} workflows In the config file's order.
 */

/**
 * Checks the default export of a config file and resolves each path against the config file's folder.
 * Throws a UsageError for a value of another shape, an unknown key, an empty workflows list, a workflow with
 * a missing or wrong-typed field, an entry, out, scenarios or map that ends in a path separator or a `.` or `..`
 * segment, a map with no scenarios, two workflows whose out paths resolve to one path or differ only in letter
 * case, an out path that names the scenarios file of any workflow by either of those rules, and a map that
 * names an entry, out, scenarios or other map of any workflow by either of those rules.
 * @param {unknown} value The default export.
 * @param {string} configFile The config file's absolute path.
 * @param {string} configPath The config file's path as the caller gave it, which each message names.
 * @returns {Config}
 */
export function checkConfig(value, configFile, configPath) {
  const configLabel = `The config file ${configPath}`;
  const configFolder = dirname(configFile);
  const workflows = [];

  if (!isObject(value)) throw new UsageError(`${configLabel} does not export default an object of the form { workflows: [...] }`);
  const unknownKey = Object.keys(value).find((key) => !CONFIG_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`${configLabel} has an unknown key ${unknownKey}`);
  if (!Array.isArray(value.workflows)) throw new UsageError(`${configLabel} has no workflows list`);
  // A check that builds nothing would pass a list emptied by mistake.
  if (value.workflows.length === 0) throw new UsageError(`${configLabel} lists no workflow`);

  // An index loop, since map() skips the holes of a sparse list.
  for (let index = 0; index < value.workflows.length; index += 1) {
    workflows.push(checkWorkflow(value.workflows[index], `Workflow ${index + 1} of the config file ${configPath}`, configFolder));
  }
  checkOutFiles(workflows, value.workflows, configPath);
  checkScenariosFiles(workflows, value.workflows, configPath);
  checkMapFiles(workflows, value.workflows, configPath);

  return { workflows };
}

/**
 * @param {unknown} row
 * @param {string} rowLabel
 * @param {string} configFolder
 * @returns {ConfigWorkflow}
 */
function checkWorkflow(row, rowLabel, configFolder) {
  if (!isObject(row)) throw new UsageError(`${rowLabel} is not an object of the form { entry, out, banner, validate, scenarios, map }`);
  const unknownKey = Object.keys(row).find((key) => !WORKFLOW_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`${rowLabel} has an unknown key ${unknownKey}`);
  const { entry, out, banner = true, validate = true, scenarios, map } = row;
  if (typeof entry !== 'string' || entry === '') throw new UsageError(`${rowLabel} needs entry, the path of an entry file`);
  if (typeof out !== 'string' || out === '') throw new UsageError(`${rowLabel} needs out, the path of the built script`);
  if (typeof banner !== 'boolean') throw new UsageError(`${rowLabel} takes banner as a boolean`);
  if (typeof validate !== 'boolean') throw new UsageError(`${rowLabel} takes validate as a boolean`);
  if (scenarios !== undefined && (typeof scenarios !== 'string' || scenarios === '')) throw new UsageError(`${rowLabel} takes scenarios as the path of a scenarios file`);
  if (isFolderPath(entry)) throw new UsageError(`${rowLabel} gives the entry ${entry}, which is not a file`);
  if (isFolderPath(out)) throw new UsageError(`${rowLabel} gives the out path ${out}, which names a folder`);
  if (scenarios !== undefined && isFolderPath(scenarios)) throw new UsageError(`${rowLabel} gives the scenarios ${scenarios}, which is not a file`);
  if (map !== undefined && (typeof map !== 'string' || map === '')) throw new UsageError(`${rowLabel} takes map as the path of a flow map file`);
  if (map !== undefined && isFolderPath(map)) throw new UsageError(`${rowLabel} gives the map ${map}, which names a folder`);
  if (map !== undefined && scenarios === undefined) throw new UsageError(`${rowLabel} gives map and no scenarios, so name the scenarios file that the flow map is drawn from`);

  return {
    entry: resolve(configFolder, entry),
    out: resolve(configFolder, out),
    banner,
    validate,
    scenarios: scenarios === undefined ? null : resolve(configFolder, scenarios),
    map: map === undefined ? null : resolve(configFolder, map),
  };
}

/**
 * @param {ConfigWorkflow[]} workflows
 * @param {{ out: string }[]} rows The workflows as the config file gives them.
 * @param {string} configPath
 */
function checkOutFiles(workflows, rows, configPath) {
  const firstIndexes = new Map();

  workflows.forEach((workflow, index) => {
    // Windows and macOS file names ignore letter case by default, so the check holds on every platform alike.
    const outKey = workflow.out.toLowerCase();
    const firstIndex = firstIndexes.get(outKey);
    if (firstIndex === undefined) {
      firstIndexes.set(outKey, index);
      return;
    }

    const label = `Workflows ${firstIndex + 1} and ${index + 1} of the config file ${configPath}`;
    if (workflows[firstIndex].out === workflow.out) throw new UsageError(`${label} both write ${rows[index].out}`);
    throw new UsageError(`${label} write ${rows[firstIndex].out} and ${rows[index].out}, which name one file where file names ignore letter case`);
  });
}

/**
 * The build would replace a hand-written scenarios file with the built script, and the build's own source
 * check cannot see it, since a scenarios file is no source of the build.
 * @param {ConfigWorkflow[]} workflows
 * @param {{ out: string, scenarios?: string }[]} rows The workflows as the config file gives them.
 * @param {string} configPath
 */
function checkScenariosFiles(workflows, rows, configPath) {
  workflows.forEach((workflow, index) => {
    const outKey = workflow.out.toLowerCase();
    const sameIndex = workflows.findIndex((other) => other.scenarios === workflow.out);
    // The user wrote both paths, and Windows and macOS file names ignore letter case by default.
    const scenariosIndex = sameIndex !== -1 ? sameIndex : workflows.findIndex((other) => other.scenarios?.toLowerCase() === outKey);
    if (scenariosIndex === -1) return;

    const message = `Workflow ${index + 1} of the config file ${configPath} writes ${rows[index].out}, which names the scenarios file ${rows[scenariosIndex].scenarios} of workflow ${scenariosIndex + 1}`;
    if (sameIndex !== -1) throw new UsageError(message);
    throw new UsageError(`${message} where file names ignore letter case`);
  });
}

/**
 * `dwfb map` would replace a source, a built script, a scenarios file or another flow map with a flow map.
 * @param {ConfigWorkflow[]} workflows
 * @param {Record<string, string>[]} rows The workflows as the config file gives them.
 * @param {string} configPath
 */
function checkMapFiles(workflows, rows, configPath) {
  workflows.forEach((workflow, index) => {
    if (workflow.map === null) return;
    const mapFile = workflow.map;
    const candidates = workflows.flatMap((other, otherIndex) =>
      MAP_CONFLICT_FIELDS.filter(([field]) => other[field] !== null && !(otherIndex === index && field === 'map')).map(([field, word]) => ({ file: other[field], field, word, otherIndex })),
    );
    // The user wrote both paths, and Windows and macOS file names ignore letter case by default.
    const sameCandidate = candidates.find((candidate) => candidate.file === mapFile);
    const conflict = sameCandidate ?? candidates.find((candidate) => candidate.file.toLowerCase() === mapFile.toLowerCase());
    if (conflict === undefined) return;

    const message = `Workflow ${index + 1} of the config file ${configPath} writes the map ${rows[index].map}, which names the ${conflict.word} ${rows[conflict.otherIndex][conflict.field]} of workflow ${conflict.otherIndex + 1}`;
    if (sameCandidate !== undefined) throw new UsageError(message);
    throw new UsageError(`${message} where file names ignore letter case`);
  });
}
