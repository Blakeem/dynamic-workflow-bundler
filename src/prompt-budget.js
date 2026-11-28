import { formatHiddenCharacters } from './format-hidden-characters.js';
import { isObject } from './is-object.js';
import { UsageError } from './usage-error.js';

const PROMPT_BUDGET_SHAPE = 'a whole number of 1 or more';

/**
 * @param {unknown} value
 * @returns {value is number} True for a whole number of 1 or more, which a prompt budget is.
 */
export function isPromptBudget(value) {
  return Number.isInteger(value) && /** @type {number} */ (value) >= 1;
}

/**
 * @param {unknown} value A promptBudgets value, from the config file or from a caller of snapshot().
 * @param {string} label The words that open each message, such as `snapshot()`.
 * @returns {asserts value is Record<string, number>}
 */
export function checkPromptBudgets(value, label) {
  if (!isObject(value)) throw new UsageError(`${label} takes promptBudgets as an object that gives a role ${PROMPT_BUDGET_SHAPE}`);
  const refusedRole = Object.keys(value).find((role) => !isPromptBudget(value[role]));
  if (refusedRole !== undefined) throw new UsageError(`${label} takes the prompt budget of the role "${formatHiddenCharacters(refusedRole)}" as ${PROMPT_BUDGET_SHAPE}`);
}
