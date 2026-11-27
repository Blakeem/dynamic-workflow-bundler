import { readKeyName, readMetaObject } from './meta-statement.js';

/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

/**
 * Gives the value of a workflow script's meta object, as the runtime reads it, and runs no code of the script.
 * @param {SyntaxNode} program The tree that parseSource gives for a script that breaks no rule of the contract,
 *   so its meta object holds literals alone.
 * @returns {Record<string, unknown> | null} Null for a script that does not open with a meta statement.
 */
export function readMetaValue(program) {
  const metaObject = readMetaObject(program.body[0]);

  return metaObject === null ? null : /** @type {Record<string, unknown>} */ (readLiteralValue(metaObject));
}

/**
 * @param {SyntaxNode} node A node that the meta-not-literal rule accepts.
 * @returns {unknown}
 */
function readLiteralValue(node) {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'TemplateLiteral':
      return node.quasis[0].value.cooked;
    case 'ArrayExpression':
      return node.elements.map(readLiteralValue);
    case 'ObjectExpression':
      // fromEntries keeps the last of two equal keys, as the runtime's object literal does.
      return Object.fromEntries(node.properties.map((property) => [readKeyName(property.key), readLiteralValue(property.value)]));
    case 'UnaryExpression':
      return -readLiteralValue(node.argument);
    default:
      throw new Error(`The meta object holds a node of type ${node.type}, which the meta-not-literal rule refuses`);
  }
}
