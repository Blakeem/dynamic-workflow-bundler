import { listTreeNodes } from './syntax-tree.js';

/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

const LABEL_KEY = 'label';
// After a separator, an `r` at the end of the fixed start opens a round marker such as `r${round}`.
const ROUND_MARKER_START = /[\s:/]r$/;
const TRAILING_SEPARATORS = /[\s:/]+$/;

/**
 * Lists the roles that the call labels of a workflow script start with, from each `label` property of an
 * object literal anywhere in the script, since a script may build the options of a call away from the call.
 * @param {SyntaxNode} program The tree that parseSource gives for the script.
 * @returns {string[]} Each role once, in source order.
 */
export function readRoles(program) {
  const labelValues = listTreeNodes(program)
    .filter((node) => node.type === 'ObjectExpression')
    .flatMap((object) => object.properties.filter(isLabelProperty))
    .map((property) => property.value);
  const roles = labelValues.map(readRole).filter((role) => role !== '');

  return [...new Set(roles)];
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
