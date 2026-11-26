import { isFunctionNode, listChildNodes, listDeclaredNames, listLexicalNames, listPatternIdentifiers, listVarNames } from './syntax-tree.js';

/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

/**
 * @callback ScopeVisitor
 * @param {SyntaxNode} node
 * @param {Set<string>[]} scopes The names each inner scope around the node declares, outermost first.
 */

/**
 * Visits every node below a program's top level, each before its children, with the inner scopes around
 * it. The top-level scope is not in the list, so a name that no listed scope holds resolves at the top level
 * or beyond the file.
 * @param {SyntaxNode} program
 * @param {ScopeVisitor} visitor
 */
export function walkScopes(program, visitor) {
  for (const statement of program.body) visitNode(statement, [], visitor);
}

/**
 * @param {SyntaxNode} node
 * @param {Set<string>[]} scopes
 * @param {ScopeVisitor} visitor
 */
function visitNode(node, scopes, visitor) {
  const visitChildren = (parent, childScopes = scopes) => {
    for (const child of listChildNodes(parent)) visitNode(child, childScopes, visitor);
  };

  visitor(node, scopes);

  if (isFunctionNode(node)) {
    visitFunction(node, scopes, visitor);
    return;
  }

  switch (node.type) {
    case 'BlockStatement':
      visitChildren(node, [...scopes, new Set(listLexicalNames(node.body))]);
      return;
    case 'StaticBlock':
      visitChildren(node, [...scopes, new Set([...listLexicalNames(node.body), ...listVarNames(node.body)])]);
      return;
    case 'SwitchStatement': {
      const caseScopes = [...scopes, new Set(node.cases.flatMap((switchCase) => listLexicalNames(switchCase.consequent)))];
      visitNode(node.discriminant, scopes, visitor);
      for (const switchCase of node.cases) visitChildren(switchCase, caseScopes);
      return;
    }
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const head = node.type === 'ForStatement' ? node.init : node.left;
      const isLexicalHead = head?.type === 'VariableDeclaration' && head.kind !== 'var';
      visitChildren(node, isLexicalHead ? [...scopes, new Set(listDeclaredNames(head))] : scopes);
      return;
    }
    case 'CatchClause':
      visitChildren(node, [...scopes, new Set(listPatternIdentifiers(node.param).map((identifier) => identifier.name))]);
      return;
    case 'ClassExpression':
      visitChildren(node, node.id ? [...scopes, new Set([node.id.name])] : scopes);
      return;
    default:
      visitChildren(node);
  }
}

/**
 * Parameters see the parameter scope only, and the body adds its `var` names on top of it. A function
 * that is not an arrow function also declares `arguments`.
 * @param {SyntaxNode} node
 * @param {Set<string>[]} scopes
 * @param {ScopeVisitor} visitor
 */
function visitFunction(node, scopes, visitor) {
  const parameterNames = node.params.flatMap((parameter) => listPatternIdentifiers(parameter).map((identifier) => identifier.name));
  const ownName = node.type === 'FunctionExpression' && node.id ? [node.id.name] : [];
  const argumentsName = node.type === 'ArrowFunctionExpression' ? [] : ['arguments'];
  const parameterScopes = [...scopes, new Set([...ownName, ...argumentsName, ...parameterNames])];
  const bodyStatements = node.body.type === 'BlockStatement' ? node.body.body : [];
  const bodyScopes = [...parameterScopes, new Set(listVarNames(bodyStatements))];

  for (const parameter of node.params) visitNode(parameter, parameterScopes, visitor);
  visitNode(node.body, bodyScopes, visitor);
}
