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
  const topLevelNames = new Set(listTopLevelNames(program.body));
  const nameNodes = new WeakSet();
  const firstByName = new Map();

  walkScopes(program, (node, scopes) => {
    for (const child of listNameChildren(node)) nameNodes.add(child);
    if (node.type !== 'Identifier' || nameNodes.has(node)) return;

    const isDeclared = topLevelNames.has(node.name) || scopes.some((scope) => scope.has(node.name));
    const earlier = firstByName.get(node.name);
    if (!isDeclared && (earlier === undefined || node.start < earlier.start)) firstByName.set(node.name, node);
  });

  return [...firstByName.values()].sort((first, second) => first.start - second.start);
}
