import { createHash } from 'node:crypto';
import { findRole } from './find-role.js';
import { isObject } from './is-object.js';
import { listUnreadScenarios } from './list-unread-scenarios.js';
import { readItem } from './read-item.js';

/** @typedef {import('./simulate.js').Trace} Trace */
/** @typedef {import('./simulate.js').TraceCall} TraceCall */
/** @typedef {import('./list-unread-scenarios.js').UnreadScenario} UnreadScenario */

const NO_LABEL_ROLE = '(no label)';
const ITEM_MASK = '<item>';
const NUMBER_MASK = 'N';
// A match ends at a character that is no letter or digit, since `\b` also counts `_` as part of a word. A digit
// is a decimal digit of any script (Nd), as DIGIT_RUN masks it, so `²` and `½` are no digit.
const NOT_AFTER_WORD = '(?<![\\p{L}\\p{Nd}])';
const NOT_BEFORE_WORD = '(?![\\p{L}\\p{Nd}])';
// A UUID comes first, since its 4-character segments are too short for a hex word. A UUID takes either case,
// since its shape tells it from a word, and a hex word stays lowercase so a word such as `DEFACED1` keeps its letters.
const HEX_ID = new RegExp(`${NOT_AFTER_WORD}(?:[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[0-9a-f]{8,})${NOT_BEFORE_WORD}`, 'gu');
const DIGIT_RUN = /\p{Nd}+/gu;
const REGEXP_SYNTAX_CHARACTER = /[\\^$.*+?()[\]{}|]/g;

/**
 * @typedef {object} SnapshotSimulation The simulation of one scenario of a scenarios file.
 * @property {string} name The scenario's name.
 * @property {Trace} trace
 */

/**
 * @typedef {object} PromptVariant One distinct prompt of a role, as the first call of the variant sent it.
 * @property {string} role
 * @property {number} number Counts the variants of the role from 1.
 * @property {number} schemaNumber Counts the distinct schema texts of the role from 1, in the order first seen.
 * @property {number} characters The `length` of the prompt.
 * @property {string} scenario The name of the scenario of the first call.
 * @property {string | null} label
 * @property {string} prompt
 * @property {unknown} schema The `schema` of the call's options, or null for a call with no schema.
 */

/**
 * @typedef {object} RolePromptSize
 * @property {string} role
 * @property {number} characters The largest prompt `length` among every call of the role.
 * @property {number | null} promptBudget The prompt budget given for the role, or null.
 */

/**
 * @typedef {{ role: string, kind: 'over', characters: number, promptBudget: number }
 *   | { role: string, kind: 'missing', characters: number, promptBudget: null }
 *   | { role: string, kind: 'unused', characters: null, promptBudget: number }} PromptBudgetProblem
 */

/**
 * @typedef {object} PromptSnapshot
 * @property {PromptVariant[] | null} variants Null when a scenario is unread.
 * @property {RolePromptSize[]} roles In the order each role's first call was made.
 * @property {number} callCount
 * @property {string | null} digest The SHA-256 of every call, as lowercase hex, or null when a scenario is unread.
 * @property {PromptBudgetProblem[]} promptBudgetProblems
 * @property {UnreadScenario[]} unread Each scenario whose simulation stopped or whose script was refused, in file order.
 */

/**
 * @typedef {object} SnapshotCall One call of a trace, with its role and the key of its variant.
 * @property {string} scenario
 * @property {string | null} label
 * @property {string} prompt
 * @property {unknown} schema
 * @property {string} schemaText
 * @property {string} role
 * @property {string} key Equal for two calls of one variant.
 */

/**
 * Lists the prompt variants of the traces of one script, the largest prompt of each role and each way those
 * sizes break the prompt budgets, and reads no disk and prints nothing. A scenario whose simulation stopped or
 * whose script was refused is unread, and then the snapshot holds no variant.
 * @param {object} input
 * @param {string[]} input.roles As readRoles gives them.
 * @param {SnapshotSimulation[]} input.runs One per scenario, in file order.
 * @param {Record<string, number> | null} input.promptBudgets By role, or null when none is given.
 * @returns {PromptSnapshot}
 */
export function buildPromptSnapshot({ roles, runs, promptBudgets }) {
  const unread = listUnreadScenarios(runs);

  if (unread.length > 0) return { variants: null, roles: [], callCount: 0, digest: null, promptBudgetProblems: [], unread };
  const calls = runs.flatMap(({ name, trace }) => trace.calls.map((call) => readSnapshotCall(call, name, roles)));
  const roleSizes = listRoleSizes(calls, promptBudgets);
  const promptBudgetProblems = promptBudgets === null ? [] : listPromptBudgetProblems(roleSizes, promptBudgets);

  return { variants: listVariants(calls), roles: roleSizes, callCount: calls.length, digest: hashCalls(calls), promptBudgetProblems, unread };
}

/**
 * @param {TraceCall} call
 * @param {string} scenario
 * @param {string[]} scriptRoles
 * @returns {SnapshotCall}
 */
function readSnapshotCall({ label, prompt, opts }, scenario, scriptRoles) {
  const scriptRole = findRole(label, scriptRoles);
  const isUnlabeled = label === null || label === '';
  const role = scriptRole ?? (isUnlabeled ? NO_LABEL_ROLE : label);
  // agent() of Claude Code 2.1.332 gives a call with no schema for a falsy schema, such as `false`, or a function,
  // and throws for any other schema that is no object (tests/fixtures/runtime/schema-probe.measured.json).
  const schema = isObject(opts) && isObject(opts.schema) ? opts.schema : null;
  const schemaText = JSON.stringify(schema, null, 2);
  const item = scriptRole === null ? '' : readItem(/** @type {string} */ (label), scriptRole);

  return { scenario, label, prompt, schema, schemaText, role, key: JSON.stringify([role, schemaText, maskPrompt(prompt, item)]) };
}

/**
 * @param {string} prompt
 * @param {string} item The call's item, or '' for none.
 * @returns {string} The prompt with the item masked, and then with the masks of maskNumbers. The item is
 *   masked only where no letter or decimal digit of any script touches it, so the item `1` leaves the `1` of
 *   `12` to the number mask. An item that maskNumbers turns into one `N` is left to it, since the item `1`
 *   would also take the `1` of `round 1`. A word item that the prompt's fixed text also holds, such as `a`,
 *   still splits a variant.
 */
function maskPrompt(prompt, item) {
  const isItemMasked = item !== '' && maskNumbers(item) !== NUMBER_MASK;
  const itemMasked = isItemMasked ? prompt.replace(createWordPattern(item), ITEM_MASK) : prompt;

  return maskNumbers(itemMasked);
}

/**
 * @param {string} text
 * @returns {string} The text with each UUID of either case and each lowercase hex word of 8 or more characters,
 *   and then each run of decimal digits of any script, such as `12` or `١٢`, written as `N`.
 */
function maskNumbers(text) {
  return text.replace(HEX_ID, NUMBER_MASK).replace(DIGIT_RUN, NUMBER_MASK);
}

/**
 * @param {string} text
 * @returns {RegExp} A global pattern of each occurrence of the text that no letter or decimal digit touches.
 */
function createWordPattern(text) {
  return new RegExp(`${NOT_AFTER_WORD}${text.replace(REGEXP_SYNTAX_CHARACTER, '\\$&')}${NOT_BEFORE_WORD}`, 'gu');
}

/**
 * @param {SnapshotCall[]} calls
 * @returns {PromptVariant[]} The first call of each key, in call order.
 */
function listVariants(calls) {
  const seenKeys = new Set();
  /** @type {Map<string, { variantCount: number, schemaNumbers: Map<string, number> }>} */
  const roleCounts = new Map();
  const variants = [];

  for (const { scenario, label, prompt, schema, schemaText, role, key } of calls) {
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const counts = roleCounts.get(role) ?? { variantCount: 0, schemaNumbers: new Map() };

    roleCounts.set(role, counts);
    counts.variantCount += 1;
    if (!counts.schemaNumbers.has(schemaText)) counts.schemaNumbers.set(schemaText, counts.schemaNumbers.size + 1);
    variants.push({ role, number: counts.variantCount, schemaNumber: /** @type {number} */ (counts.schemaNumbers.get(schemaText)), characters: prompt.length, scenario, label, prompt, schema });
  }
  return variants;
}

/**
 * @param {SnapshotCall[]} calls
 * @param {Record<string, number> | null} promptBudgets
 * @returns {RolePromptSize[]}
 */
function listRoleSizes(calls, promptBudgets) {
  /** @type {Map<string, number>} */
  const largest = new Map();

  for (const { role, prompt } of calls) largest.set(role, Math.max(largest.get(role) ?? 0, prompt.length));
  return [...largest].map(([role, characters]) => ({ role, characters, promptBudget: promptBudgets !== null && Object.hasOwn(promptBudgets, role) ? promptBudgets[role] : null }));
}

/**
 * @param {RolePromptSize[]} roleSizes
 * @param {Record<string, number>} promptBudgets
 * @returns {PromptBudgetProblem[]} Each role over its prompt budget or with none, in the order of the roles,
 *   then each prompt budget of no role, in key order.
 */
function listPromptBudgetProblems(roleSizes, promptBudgets) {
  /** @type {PromptBudgetProblem[]} */
  const problems = [];
  const roleNames = new Set(roleSizes.map(({ role }) => role));

  for (const { role, characters, promptBudget } of roleSizes) {
    if (promptBudget === null) problems.push({ role, kind: 'missing', characters, promptBudget });
    else if (characters > promptBudget) problems.push({ role, kind: 'over', characters, promptBudget });
  }
  for (const [role, promptBudget] of Object.entries(promptBudgets)) {
    if (!roleNames.has(role)) problems.push({ role, kind: 'unused', characters: null, promptBudget });
  }
  return problems;
}

/**
 * @param {SnapshotCall[]} calls
 * @returns {string} The SHA-256, as lowercase hex, of one JSON line of the label, the prompt and the schema per call.
 */
function hashCalls(calls) {
  const hash = createHash('sha256');

  for (const { label, prompt, schema } of calls) hash.update(`${JSON.stringify([label, prompt, schema])}\n`, 'utf8');
  return hash.digest('hex');
}
