import { findPosition, replaceLoneCarriageReturns } from './source-position.js';
import { listTreeNodes } from './syntax-tree.js';

/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

/**
 * @typedef {object} ThrowSite
 * @property {number} line The line of the `throw` keyword, from 1.
 * @property {string} prefix The fixed text the message starts with, which a thrown message is matched by.
 * @property {string} template The message with `...` for each expression of a template literal, which a flow map
 *   shows. A concatenation gives the text of its leftmost operand alone.
 * @property {boolean} isMessageBuilt True when the message argument holds an expression, so the runtime builds the
 *   message. False for no argument, a string literal and a template literal with no expression.
 */

export const EXPRESSION_MARK = '...';

/**
 * Lists the throw sites of a workflow script: each `throw new <Name>(...)` statement.
 * @param {SyntaxNode} program The tree that parseSource gives for the script.
 * @param {string} text The text the program was parsed from. Acorn's own line count also breaks at U+2028
 *   and U+2029, so the line is counted as checkContract places a finding: at LF and at a lone CR.
 * @returns {ThrowSite[]} In source order.
 */
export function readThrowSites(program, text) {
  const throwStatements = listTreeNodes(program).filter(isThrowSite);
  const positionText = replaceLoneCarriageReturns(text);

  return throwStatements.map((statement) => ({
    line: findPosition(positionText, statement.start).line,
    ...readMessageText(statement.argument.arguments[0]),
  }));
}

/**
 * @param {SyntaxNode} node
 * @returns {boolean}
 */
function isThrowSite(node) {
  return node.type === 'ThrowStatement' && node.argument.type === 'NewExpression' && node.argument.callee.type === 'Identifier';
}

/**
 * A `+` expression gives what its leftmost operand gives, so `'Invalid args (' + error.message` gives its literal.
 * @param {SyntaxNode | undefined} argument The first argument of the `new` expression.
 * @returns {{ prefix: string, template: string, isMessageBuilt: boolean }} Both texts '' for no argument or an
 *   expression of another kind.
 */
function readMessageText(argument) {
  let operand = argument;

  if (argument === undefined) return { prefix: '', template: '', isMessageBuilt: false };
  while (operand.type === 'BinaryExpression' && operand.operator === '+') operand = operand.left;
  const isConcatenation = operand !== argument;

  if (operand.type === 'Literal' && typeof operand.value === 'string') return { prefix: operand.value, template: operand.value, isMessageBuilt: isConcatenation };
  if (operand.type !== 'TemplateLiteral') return { prefix: '', template: '', isMessageBuilt: true };

  const texts = operand.quasis.map((quasi) => quasi.value.cooked);

  return { prefix: texts[0], template: texts.join(EXPRESSION_MARK), isMessageBuilt: isConcatenation || operand.expressions.length > 0 };
}
