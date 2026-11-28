import { listTreeNodes } from './syntax-tree.js';

/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

const LABEL_KEY = 'label';
/** The regular expression class of the characters that separate a role, an item and a round marker in a label. */
export const LABEL_SEPARATOR = String.raw`[\s:/]`;
// After a separator, an `r` at the end of the fixed start opens a round marker such as `r${round}`.
const ROUND_MARKER_START = new RegExp(`${LABEL_SEPARATOR}r$`);
const TRAILING_SEPARATORS = new RegExp(`${LABEL_SEPARATOR}+$`);

/**
 * @typedef {object} RolePlace
 * @property {string} role
 * @property {number} offset The offset of the value of the first `label` property that gives the role.
 */

/**
 * Lists the roles that the call labels of a workflow script start with, from each `label` property of an
 * object literal anywhere in the script, since a script may build the options of a call away from the call.
 * @param {SyntaxNode} program The tree that parseSource gives for the script.
 * @returns {string[]} Each role once, in source order.
 */
export function readRoles(program) {
  return readRolePlaces(program).map(({ role }) => role);
}

/**
 * Lists the roles as readRoles does, each with the place of the first label that gives it.
 * @param {SyntaxNode} program The tree that parseSource gives for the script.
 * @returns {RolePlace[]} Each role once, in source order.
 */
export function readRolePlaces(program) {
  const offsets = new Map();
  const labelValues = listTreeNodes(program)
    .filter((node) => node.type === 'ObjectExpression')
    .flatMap((object) => object.properties.filter(isLabelProperty))
    .map((property) => property.value);

  for (const value of labelValues) {
    const role = readRole(value);
    if (role !== '' && !offsets.has(role)) offsets.set(role, value.start);
  }
  return [...offsets].map(([role, offset]) => ({ role, offset }));
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
