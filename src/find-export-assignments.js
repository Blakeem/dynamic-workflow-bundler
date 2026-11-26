import { listPatternIdentifiers } from './syntax-tree.js';
import { walkScopes } from './walk-scopes.js';

/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

/**
 * Finds each assignment to a module's exported top-level binding, skipping a name that an inner scope
 * declares again. A scope returns its exports once, so a later assignment would not reach an importer.
 * @param {SyntaxNode} program
 * @param {Set<string>} exportedNames The local names of the module's exported bindings.
 * @returns {SyntaxNode[]} The assigned identifiers, in source order.
 */
export function findExportAssignments(program, exportedNames) {
  const found = [];
  if (exportedNames.size === 0) return found;

  walkScopes(program, (node, scopes) => {
    for (const identifier of listPatternIdentifiers(readAssignmentTarget(node))) {
      const isShadowed = scopes.some((scope) => scope.has(identifier.name));
      if (exportedNames.has(identifier.name) && !isShadowed) found.push(identifier);
    }
  });

  return found.sort((first, second) => first.start - second.start);
}

/**
 * @param {SyntaxNode} node
 * @returns {SyntaxNode | null} The pattern that the node assigns to, or null when it assigns nothing.
 */
function readAssignmentTarget(node) {
  const isForInOrOf = node.type === 'ForInStatement' || node.type === 'ForOfStatement';

  if (node.type === 'AssignmentExpression') return node.left;
  if (node.type === 'UpdateExpression') return node.argument;
  if (isForInOrOf && node.left.type !== 'VariableDeclaration') return node.left;
  return null;
}
