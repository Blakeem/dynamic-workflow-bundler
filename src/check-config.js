import { dirname, resolve } from 'node:path';
import { isFolderPath } from './display-path.js';
import { UsageError } from './usage-error.js';

const CONFIG_KEYS = new Set(['workflows']);
const WORKFLOW_KEYS = new Set(['entry', 'out', 'banner']);

/**
 * @typedef {object} ConfigWorkflow
 * @property {string} entry The entry file's absolute path.
 * @property {string} out The built script's absolute path.
 * @property {boolean} banner Defaults to true.
 */

/**
 * @typedef {object} Config
 * @property {ConfigWorkflow[]} workflows In the config file's order.
 */

/**
 * Checks the default export of a config file and resolves each path against the config file's folder.
 * Throws a UsageError for a value of another shape, an unknown key, an empty workflows list, a workflow with
 * a missing or wrong-typed field, an entry or out that ends in a path separator or a `.` or `..` segment, and
 * two workflows whose out paths resolve to one path or differ only in letter case.
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

  return { workflows };
}

/**
 * @param {unknown} row
 * @param {string} rowLabel
 * @param {string} configFolder
 * @returns {ConfigWorkflow}
 */
function checkWorkflow(row, rowLabel, configFolder) {
  if (!isObject(row)) throw new UsageError(`${rowLabel} is not an object of the form { entry, out, banner }`);
  const unknownKey = Object.keys(row).find((key) => !WORKFLOW_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`${rowLabel} has an unknown key ${unknownKey}`);
  const { entry, out, banner = true } = row;
  if (typeof entry !== 'string' || entry === '') throw new UsageError(`${rowLabel} needs entry, the path of an entry file`);
  if (typeof out !== 'string' || out === '') throw new UsageError(`${rowLabel} needs out, the path of the built script`);
  if (typeof banner !== 'boolean') throw new UsageError(`${rowLabel} takes banner as a boolean`);
  if (isFolderPath(entry)) throw new UsageError(`${rowLabel} gives the entry ${entry}, which is not a file`);
  if (isFolderPath(out)) throw new UsageError(`${rowLabel} gives the out path ${out}, which names a folder`);

  return { entry: resolve(configFolder, entry), out: resolve(configFolder, out), banner };
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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
