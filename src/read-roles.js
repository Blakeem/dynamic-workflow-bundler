import { listTreeNodes } from './syntax-tree.js';

/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

const LABEL_KEY = 'label';
/** The regular expression class of the characters that separate a role, an item and a round marker in a label. */
export const LABEL_SEPARATOR = String.raw`[\s:/]`;
// After a separator, an `r` at the end of the fixed start opens a round marker such as `r${round}`.
const ROUND_MARKER_START = new RegExp(`${LABEL_SEPARATOR}r$`);
const TRAILING_SEPARATORS = new RegExp(`${LABEL_SEPARATOR}+$`);

/**
 * @typedef {object} RoleLabel One `label` property that gives a role.
 * @property {number} keyOffset The offset of its key.
 * @property {number} valueOffset The offset of its value.
 */

/**
 * @typedef {object} RolePlace
 * @property {string} role
 * @property {RoleLabel[]} labels Each `label` property that gives the role, in source order. The first one places
 *   the role.
 */

/**
 * Lists the roles that the call labels of a workflow script start with, from each `label` property of an
 * object literal anywhere in the script, since a script may build the options of a call away from the call.
 * @param {SyntaxNode} program The tree that parseSource gives for the script.
 * @returns {string[]} Each role once, ordered by the start of the first object literal whose `label` property
 *   gives it, so a role of an outer object comes before a role of an object nested in it.
 */
export function readRoles(program) {
  return readRolePlaces(program).map(({ role }) => role);
}

/**
 * Lists the roles as readRoles does, each with the place of every label that gives it.
 * @param {SyntaxNode} program The tree that parseSource gives for the script.
 * @returns {RolePlace[]} Each role once, in the order readRoles gives.
 */
export function readRolePlaces(program) {
  const roleLabels = new Map();
  const labelProperties = listTreeNodes(program)
    .filter((node) => node.type === 'ObjectExpression')
    .flatMap((object) => object.properties.filter(isLabelProperty));

  for (const { key, value } of labelProperties) {
    const role = readRole(value);
    if (role === '') continue;
    if (!roleLabels.has(role)) roleLabels.set(role, []);
    roleLabels.get(role).push({ keyOffset: key.start, valueOffset: value.start });
  }
  // The walk gives an object's labels before those of an object nested in it, which can sit earlier.
  // Every reader of readRoles depends on the role order, so only the labels are sorted.
  return [...roleLabels].map(([role, labels]) => ({ role, labels: labels.sort((first, second) => first.keyOffset - second.keyOffset) }));
}

/**
 * @param {SyntaxNode} property A property or a spread element of an object literal.
 * @returns {boolean} True for a property whose key is the name or the string `label`, not computed.
 */
function isLabelProperty(property) {
  if (property.type !== 'Property' || property.computed) return false;
  return property.key.type === 'Identifier' ? property.key.name === LABEL_KEY : property.key.value === LABEL_KEY;
}

/**
 * @param {SyntaxNode} value The value of a label property.
 * @returns {string} The role, or '' for a value that gives none.
 */
function readRole(value) {
  let fixedStart = '';
  let hasExpression = false;

  if (value.type === 'Literal' && typeof value.value === 'string') {
    fixedStart = value.value;
  } else if (value.type === 'TemplateLiteral') {
    fixedStart = value.quasis[0].value.cooked;
    hasExpression = value.expressions.length > 0;
  }

  const withoutRoundMarker = hasExpression && ROUND_MARKER_START.test(fixedStart) ? fixedStart.slice(0, -1) : fixedStart;

  return withoutRoundMarker.replace(TRAILING_SEPARATORS, '');
}
