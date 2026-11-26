import { listNameChildren, listTopLevelNames } from './syntax-tree.js';
import { walkScopes } from './walk-scopes.js';

/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

/**
 * Finds the first reference to each name that no scope of the file declares, which an ES module
 * resolves to a global.
 * @param {SyntaxNode} program
 * @returns {SyntaxNode[]} One identifier per name, in source order.
 */
export function findFreeNames(program) {
  const firstByName = new Map();

  for (const identifier of listFreeReferences(program)) {
    if (!firstByName.has(identifier.name)) firstByName.set(identifier.name, identifier);
  }

  return [...firstByName.values()];
}

/**
 * Lists every reference to a name that no scope of the file declares.
 * @param {SyntaxNode} program
 * @returns {SyntaxNode[]} The identifiers, in source order.
 */
export function listFreeReferences(program) {
  const topLevelNames = new Set(listTopLevelNames(program.body));
  const nameNodes = new WeakSet();
  const references = [];

  walkScopes(program, (node, scopes) => {
    for (const child of listNameChildren(node)) nameNodes.add(child);
    if (node.type !== 'Identifier' || nameNodes.has(node)) return;

    const isDeclared = topLevelNames.has(node.name) || scopes.some((scope) => scope.has(node.name));
    if (!isDeclared) references.push(node);
  });

  return references.sort((first, second) => first.start - second.start);
}
