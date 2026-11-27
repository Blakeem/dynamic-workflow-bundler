/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

/**
 * Reads the meta object of a statement of the form `export const meta = { ... }`, with `const` and one
 * declarator, which the runtime requires as a script's first statement (Claude Code 2.1.332). Acorn gives
 * a parenthesized object literal no node of its own, so `({ ... })` has the form too.
 * @param {SyntaxNode | undefined} statement
 * @returns {SyntaxNode | null} The ObjectExpression, or null when the statement does not have the form.
 */
export function readMetaObject(statement) {
  const declaration = statement?.type === 'ExportNamedDeclaration' ? statement.declaration : null;
  const isConstDeclaration = declaration?.type === 'VariableDeclaration' && declaration.kind === 'const' && declaration.declarations.length === 1;
  const declarator = isConstDeclaration ? declaration.declarations[0] : null;
  const isMeta = declarator?.id.type === 'Identifier' && declarator.id.name === 'meta' && declarator.init?.type === 'ObjectExpression';

  return isMeta ? declarator.init : null;
}

/**
 * @param {SyntaxNode} key A key that is not computed: a name, a keyword, a string, a number or a bigint.
 * @returns {string}
 */
export function readKeyName(key) {
  return key.type === 'Identifier' ? key.name : String(key.value);
}
