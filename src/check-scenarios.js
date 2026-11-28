import { formatHiddenCharacters } from './format-hidden-characters.js';
import { isObject } from './is-object.js';
import { checkScenario, SCENARIO_KEYS } from './simulate.js';
import { UsageError } from './usage-error.js';

/** @typedef {import('./simulate.js').Scenario} Scenario */

const SCENARIO_ROW_KEYS = new Set([...SCENARIO_KEYS, 'expect', 'when', 'endState']);
const SCENARIO_ROW_FORM = `{ ${[...SCENARIO_ROW_KEYS].join(', ')} }`;
const EXPECTED_ENDS = new Set(['returned', 'threw']);

/**
 * @typedef {object} FileScenario One scenario of a scenarios file.
 * @property {string} name
 * @property {'returned' | 'threw'} expect The end kind of a simulation that passes. Defaults to 'returned'.
 * @property {string} when The words that say when the scenario's path is taken, which a flow map shows.
 *   Defaults to the name.
 * @property {string | null} endState The end state a flow map and the coverage give a script that returns no
 *   status, or null.
 *   A flow map leaves the scenario unmapped when the script returns a status that differs from it, digit runs aside.
 * @property {Scenario} scenario The scenario as simulate() takes it, with its name.
 */

/**
 * Checks the default export of a scenarios file: a list of scenarios as simulate() takes them, each with a
 * name that no other scenario of the list has and an optional `expect`, `when` and `endState`.
 * Throws a UsageError for a value of another shape, an empty list, an unknown key, a missing or repeated name,
 * an `expect` other than 'returned' or 'threw', a `when` or `endState` that is not a string of 1 or more
 * characters, and every scenario problem that simulate() names.
 * @param {unknown} value The default export.
 * @param {string} scenariosPath The scenarios file's path as the caller gave it, which each message names.
 * @returns {FileScenario[]} In the file's order.
 */
export function checkScenarios(value, scenariosPath) {
  const fileLabel = `The scenarios file ${scenariosPath}`;
  const fileScenarios = [];
  const firstIndexes = new Map();

  if (!Array.isArray(value)) throw new UsageError(`${fileLabel} does not export default a list of scenarios of the form ${SCENARIO_ROW_FORM}`);
  // A run of no scenario would pass a list emptied by mistake.
  if (value.length === 0) throw new UsageError(`${fileLabel} lists no scenario`);

  // An index loop, since map() skips the holes of a sparse list.
  for (let index = 0; index < value.length; index += 1) {
    const fileScenario = checkScenarioRow(value[index], `Scenario ${index + 1} of the scenarios file ${scenariosPath}`);
    const firstIndex = firstIndexes.get(fileScenario.name);
    if (firstIndex !== undefined) {
      throw new UsageError(`Scenarios ${firstIndex + 1} and ${index + 1} of the scenarios file ${scenariosPath} are both named "${formatHiddenCharacters(fileScenario.name)}"`);
    }
    firstIndexes.set(fileScenario.name, index);
    fileScenarios.push(fileScenario);
  }

  return fileScenarios;
}

/**
 * @param {unknown} row
 * @param {string} rowLabel
 * @returns {FileScenario}
 */
function checkScenarioRow(row, rowLabel) {
  if (!isObject(row)) throw new UsageError(`${rowLabel} is not an object of the form ${SCENARIO_ROW_FORM}`);
  const unknownKey = Object.keys(row).find((key) => !SCENARIO_ROW_KEYS.has(key));
  if (unknownKey !== undefined) throw new UsageError(`${rowLabel} has an unknown key ${unknownKey}`);
  const { expect = 'returned', when, endState, ...scenario } = row;
  if (typeof scenario.name !== 'string' || scenario.name === '') throw new UsageError(`${rowLabel} needs name, a name that no other scenario of the file has`);
  if (typeof expect !== 'string' || !EXPECTED_ENDS.has(expect)) throw new UsageError(`${rowLabel} takes expect as 'returned' or 'threw'`);
  if (when !== undefined && !isNonEmptyString(when)) throw new UsageError(`${rowLabel} takes when as a string of 1 or more characters that says when its path is taken`);
  if (endState !== undefined && !isNonEmptyString(endState)) throw new UsageError(`${rowLabel} takes endState as a string of 1 or more characters that names its end state`);
  try {
    checkScenario(scenario);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    throw new UsageError(`${rowLabel} is not valid. ${error.message}`);
  }

  return {
    name: scenario.name,
    expect: /** @type {'returned' | 'threw'} */ (expect),
    when: when ?? scenario.name,
    endState: endState ?? null,
    scenario: /** @type {Scenario} */ (scenario),
  };
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}
