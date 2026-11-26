/** @typedef {{ type: string, start: number, end: number, [key: string]: any }} SyntaxNode */

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const EXPORT_DECLARATION_TYPES = new Set(['ExportNamedDeclaration', 'ExportDefaultDeclaration']);
const KEY_TYPES = new Set(['Property', 'PropertyDefinition', 'MethodDefinition']);
const LABEL_TYPES = new Set(['LabeledStatement', 'BreakStatement', 'ContinueStatement']);
// Node.js 24.22.1 gives a RangeError of this message when a recursive call overflows the stack.
const STACK_OVERFLOW_MESSAGE = 'Maximum call stack size exceeded';
/** The types of a statement that exports. */
export const EXPORT_TYPES = new Set(['ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration']);

/**
 * @param {SyntaxNode} node
 * @returns {boolean}
 */
export function isFunctionNode(node) {
  return FUNCTION_TYPES.has(node.type);
}

/**
 * Lists the direct child nodes of a node, in source order.
 * @param {SyntaxNode} node
 * @returns {SyntaxNode[]}
 */
export function listChildNodes(node) {
  const children = [];

  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || value === null || typeof value !== 'object') continue;
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (candidate !== null && typeof candidate === 'object' && typeof candidate.type === 'string') {
        children.push(candidate);
      }
    }
  }

  return children;
}

/**
 * Finds the first node, in source order, at the greatest depth below a node.
 * It keeps its own stack, so it reads a tree that a recursive walk overflows on.
 * @param {SyntaxNode} node
 * @returns {SyntaxNode}
 */
export function findDeepestNode(node) {
  const pending = [{ node, depth: 0 }];
  let deepest = pending[0];

  while (pending.length > 0) {
    const current = pending.pop();
    const children = listChildNodes(current.node);
    if (current.depth > deepest.depth) deepest = current;
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push({ node: children[index], depth: current.depth + 1 });
  }

  return deepest.node;
}

/**
 * @param {unknown} error
 * @returns {boolean} True for the error of a call stack overflow, which a recursive tree walk gives on a tree too deep.
 */
export function isStackOverflowError(error) {
  return error instanceof RangeError && error.message === STACK_OVERFLOW_MESSAGE;
}

/**
 * Lists the identifiers directly below a node, or in the specifiers of an `export { ... } from`, that name a
 * property, a label, an import or an export, and that bind and reference no variable.
 * Acorn gives `import { a }` and `export { a }` one node for both names, and that node is the variable's.
 * In `export { a as b } from './m.js'`, `a` names an export of m.js and `b` an export of the file, and neither is a variable.
 * @param {SyntaxNode} node
 * @returns {SyntaxNode[]}
 */
export function listNameChildren(node) {
  if (node.type === 'MemberExpression' && !node.computed) return [node.property];
  if (KEY_TYPES.has(node.type) && !node.computed) return [node.key];
  if (LABEL_TYPES.has(node.type) && node.label) return [node.label];
  if (node.type === 'MetaProperty') return [node.meta, node.property];
  if (node.type === 'ImportSpecifier') return node.imported === node.local ? [] : [node.imported];
  if (node.type === 'ImportAttribute') return [node.key];
  if (node.type === 'ExportSpecifier') return node.exported === node.local ? [] : [node.exported];
  if (node.type === 'ExportAllDeclaration') return node.exported ? [node.exported] : [];
  if (node.type === 'ExportNamedDeclaration' && node.source) return node.specifiers.map((specifier) => specifier.local);
  return [];
}

/**
 * Lists the identifiers that a binding or assignment pattern names.
 * A member expression target names no identifier.
 * @param {SyntaxNode | null} pattern
 * @returns {SyntaxNode[]}
 */
export function listPatternIdentifiers(pattern) {
  return listPatternTargets(pattern).filter((target) => target.type === 'Identifier');
}

/**
 * Lists the targets that a binding or assignment pattern writes: each identifier and each member expression.
 * @param {SyntaxNode | null} pattern
 * @returns {SyntaxNode[]}
 */
export function listPatternTargets(pattern) {
  if (pattern === null) return [];

  switch (pattern.type) {
    case 'Identifier':
    case 'MemberExpression':
      return [pattern];
    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        listPatternTargets(property.type === 'RestElement' ? property.argument : property.value),
      );
    case 'ArrayPattern':
      return pattern.elements.flatMap((element) => listPatternTargets(element));
    case 'AssignmentPattern':
      return listPatternTargets(pattern.left);
    case 'RestElement':
      return listPatternTargets(pattern.argument);
    default:
      return [];
  }
}

/**
 * Lists the names that a declaration statement binds.
 * @param {SyntaxNode} declaration
 * @returns {string[]}
 */
export function listDeclaredNames(declaration) {
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((declarator) =>
      listPatternIdentifiers(declarator.id).map((identifier) => identifier.name),
    );
  }
  if (declaration.id) return [declaration.id.name];
  return [];
}

/**
 * Lists the names that `let`, `const`, `class` and `function` declarations bind directly in a statement list.
 * In strict code a function declaration in a block binds in that block.
 * @param {SyntaxNode[]} statements
 * @returns {string[]}
 */
export function listLexicalNames(statements) {
  return statements
    .filter(
      (statement) =>
        (statement.type === 'VariableDeclaration' && statement.kind !== 'var') ||
        statement.type === 'ClassDeclaration' ||
        statement.type === 'FunctionDeclaration',
    )
    .flatMap((statement) => listDeclaredNames(statement));
}

/**
 * Lists the names that a file's top-level statements bind, including imported names and the names of
 * exported declarations.
 * @param {SyntaxNode[]} statements
 * @returns {string[]}
 */
export function listTopLevelNames(statements) {
  const declarations = statements.map((statement) => (EXPORT_DECLARATION_TYPES.has(statement.type) && statement.declaration ? statement.declaration : statement));
  const importedNames = statements
    .filter((statement) => statement.type === 'ImportDeclaration')
    .flatMap((statement) => statement.specifiers.map((specifierNode) => specifierNode.local.name));

  return [...listLexicalNames(declarations), ...listVarNames(statements), ...importedNames];
}

/**
 * Lists the names that `var` declarations bind anywhere in a statement list, outside nested functions.
 * @param {SyntaxNode[]} statements
 * @returns {string[]}
 */
export function listVarNames(statements) {
  const names = [];
  const collect = (node) => {
    if (isFunctionNode(node) || node.type === 'StaticBlock') return;
    if (node.type === 'VariableDeclaration' && node.kind === 'var') names.push(...listDeclaredNames(node));
    for (const child of listChildNodes(node)) collect(child);
  };

  for (const statement of statements) collect(statement);
  return names;
}
