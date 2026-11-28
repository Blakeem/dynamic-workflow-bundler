import { normalizeDigits } from './normalize-digits.js';
import { findPosition, readPositionText } from './source-position.js';
import { listTreeNodes } from './syntax-tree.js';

/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

const END_STATES_COMMENT = /^\s*@end-states(?=\s|$)/;
const UNREACHED_COMMENT = /^\s*@unreached(?=\s|$)/;
// Acorn ends a line comment before the CR of a CRLF, and also at U+2028 or U+2029, where code can follow.
const LINE_END_REST = /^\r?$/;
const END_STATES_MISPLACED_MESSAGE = 'The // @end-states comment is not alone on the line above a const that lists end states';
const UNREACHED_MISPLACED_MESSAGE = 'The // @unreached comment is not alone on the line above a throw site or a label';
const UNREACHED_NO_REASON_MESSAGE = 'The // @unreached comment gives no reason';

/**
 * @typedef {object} DeclaredEndState
 * @property {string} endState As its declaration writes it.
 * @property {number} offset The offset of its string in the script.
 */

/**
 * @typedef {object} CoverageDirectiveProblem
 * @property {'end-states-misplaced' | 'unreached-misplaced' | 'unreached-no-reason'} rule
 * @property {string} message
 * @property {number} offset The offset of the comment in the script.
 */

/**
 * @typedef {object} CoverageDirectives
 * @property {DeclaredEndState[]} endStates The end states of every `// @end-states` comment, in source order,
 *   each once when compared with each run of digits written as `N`.
 * @property {Map<number, string>} unreachedReasons By the line of the `new` keyword of each throw site that a
 *   `// @unreached` comment marks, the comment's reason, or '' for a comment that gives none.
 * @property {Map<string, RoleMark>} roleMarks By each role that a `// @unreached` comment marks, its first such
 *   comment in source order. A comment above a line with a throw site marks the throw site alone.
 * @property {CoverageDirectiveProblem[]} problems
 */

/**
 * @typedef {object} RoleMark
 * @property {string} reason The comment's reason, or '' for a comment that gives none.
 * @property {number} offset The offset of the value of the first `label` property of the role that it marks.
 */

/**
 * Reads the `// @end-states` and `// @unreached` comments of a workflow script. A misplaced comment marks
 * nothing and declares nothing.
 * @param {SyntaxNode} program The tree that parseSource gives for the script.
 * @param {import('acorn').Comment[]} comments The comments acorn reported for the same parse, in source order.
 * @param {string} text The text the program was parsed from.
 * @param {import('./read-throw-sites.js').ThrowSite[]} throwSites As readThrowSites gives them.
 * @param {import('./read-roles.js').RolePlace[]} rolePlaces As readRolePlaces gives them.
 * @returns {CoverageDirectives}
 */
export function readCoverageDirectives(program, comments, text, throwSites, rolePlaces) {
  const endStates = [];
  const endStateKeys = new Set();
  const unreachedReasons = new Map();
  const roleMarks = new Map();
  const problems = [];
  // Acorn 8.19.0 reports a #! line at the start of the script as a Line comment.
  const lineComments = comments.filter((comment) => comment.type === 'Line' && text.startsWith('//', comment.start));
  const endStatesComments = lineComments.filter((comment) => END_STATES_COMMENT.test(comment.value));
  const unreachedComments = lineComments.filter((comment) => UNREACHED_COMMENT.test(comment.value));
  const { positionText, markLength } = readPositionText(text);
  const throwSiteLines = new Set(throwSites.map(({ line }) => line));
  const roleLabelsByLine = readRoleLabelsByLine(rolePlaces, positionText, markLength);
  // A script with no `// @end-states` comment needs no walk of its tree.
  const constDeclarations = endStatesComments.length === 0 ? [] : listTreeNodes(program).filter(isConstDeclaration);

  for (const comment of endStatesComments) {
    const commentLine = readCommentLine(positionText, comment, markLength);
    const stringNodes = commentLine.isAlone ? findEndStateNodes(constDeclarations, commentLine.nextLine, markLength) : null;

    if (stringNodes === null) {
      problems.push({ rule: 'end-states-misplaced', message: END_STATES_MISPLACED_MESSAGE, offset: comment.start });
      continue;
    }
    for (const node of stringNodes) {
      const endState = readStringValue(node);
      const key = normalizeDigits(endState);

      if (endStateKeys.has(key)) continue;
      endStateKeys.add(key);
      endStates.push({ endState, offset: node.start });
    }
  }

  for (const comment of unreachedComments) {
    const commentLine = readCommentLine(positionText, comment, markLength);
    const reason = comment.value.replace(UNREACHED_COMMENT, '').trim();
    const markedLine = commentLine.line + 1;
    const marksThrowSite = throwSiteLines.has(markedLine);
    // Marking a label on a throw site's line gives role-reached when another call reaches the role, and removing the comment unmarks the site.
    const markedLabels = marksThrowSite ? [] : (roleLabelsByLine.get(markedLine) ?? []);

    if (reason === '') problems.push({ rule: 'unreached-no-reason', message: UNREACHED_NO_REASON_MESSAGE, offset: comment.start });
    if (!commentLine.isAlone || (!marksThrowSite && markedLabels.length === 0)) {
      problems.push({ rule: 'unreached-misplaced', message: UNREACHED_MISPLACED_MESSAGE, offset: comment.start });
      continue;
    }
    if (marksThrowSite) unreachedReasons.set(markedLine, reason);
    for (const { role, valueOffset } of markedLabels) {
      if (!roleMarks.has(role)) roleMarks.set(role, { reason, offset: valueOffset });
    }
  }

  return { endStates, unreachedReasons, roleMarks, problems };
}

/**
 * @param {import('./read-roles.js').RolePlace[]} rolePlaces As readRolePlaces gives them.
 * @param {string} positionText As readPositionText gives it.
 * @param {number} markLength As readPositionText gives it.
 * @returns {Map<number, { role: string, valueOffset: number }[]>} By line, each `label` property whose key starts
 *   on it, with the labels of one role in source order.
 */
function readRoleLabelsByLine(rolePlaces, positionText, markLength) {
  const labelsByLine = new Map();

  for (const { role, labels } of rolePlaces) {
    for (const { keyOffset, valueOffset } of labels) {
      const { line } = findPosition(positionText, Math.max(0, keyOffset - markLength));
      if (!labelsByLine.has(line)) labelsByLine.set(line, []);
      labelsByLine.get(line).push({ role, valueOffset });
    }
  }
  return labelsByLine;
}

/**
 * Places a comment as readThrowSites places a throw site: at LF and at a lone CR, after a leading byte order mark.
 * @param {string} positionText As readPositionText gives it.
 * @param {import('acorn').Comment} comment
 * @param {number} markLength As readPositionText gives it.
 * @returns {{ line: number, isAlone: boolean, nextLine: { start: number, end: number } | null }} `nextLine`
 *   holds the offsets in `positionText` of the line below the comment, or null for a comment on the last line.
 */
function readCommentLine(positionText, comment, markLength) {
  const start = comment.start - markLength;
  const end = comment.end - markLength;
  const lineStart = positionText.lastIndexOf('\n', start - 1) + 1;
  const lineBreak = positionText.indexOf('\n', end);
  const lineEnd = lineBreak === -1 ? positionText.length : lineBreak;
  const isAlone = positionText.slice(lineStart, start).trim() === '' && LINE_END_REST.test(positionText.slice(end, lineEnd));
  const nextLineBreak = lineBreak === -1 ? -1 : positionText.indexOf('\n', lineBreak + 1);
  const nextLine = lineBreak === -1 ? null : { start: lineBreak + 1, end: nextLineBreak === -1 ? positionText.length : nextLineBreak };

  return { line: findPosition(positionText, start).line, isAlone, nextLine };
}

/**
 * @param {SyntaxNode} node
 * @returns {boolean}
 */
function isConstDeclaration(node) {
  return node.type === 'VariableDeclaration' && node.kind === 'const';
}

/**
 * @param {SyntaxNode[]} declarations In source order.
 * @param {{ start: number, end: number } | null} line Offsets in the position text.
 * @param {number} markLength
 * @returns {SyntaxNode[] | null} The strings that readEndStateNodes gives for the first declaration that starts on
 *   the line and lists end states, or null when none does.
 */
function findEndStateNodes(declarations, line, markLength) {
  if (line === null) return null;
  for (const declaration of declarations) {
    const start = declaration.start - markLength;
    if (start >= line.end) break;
    const stringNodes = start >= line.start ? readEndStateNodes(declaration) : null;

    if (stringNodes !== null) return stringNodes;
  }
  return null;
}

/**
 * @param {SyntaxNode} declaration A const declaration.
 * @returns {SyntaxNode[] | null} The string of each end state the declaration lists, or null when it lists none
 *   in the form a `// @end-states` comment takes.
 */
function readEndStateNodes(declaration) {
  if (declaration.declarations.length !== 1) return null;
  const [declarator] = declaration.declarations;
  if (declarator.id.type !== 'Identifier') return null;
  const list = readFrozenArgument(declarator.init);
  if (list?.type !== 'ArrayExpression' && list?.type !== 'ObjectExpression') return null;
  // A key is not read, so a computed key is kept, and a spread element reaches the check as no string.
  const values = list.type === 'ArrayExpression' ? list.elements : list.properties.map((property) => (property.type === 'Property' ? property.value : property));

  return values.length > 0 && values.every(isEndStateString) ? values : null;
}

/**
 * @param {SyntaxNode | null} init
 * @returns {SyntaxNode | null} The one argument of `Object.freeze(...)`, or the value itself for any other value.
 */
function readFrozenArgument(init) {
  const callee = init?.type === 'CallExpression' && !init.optional ? init.callee : null;
  const isFreeze = callee?.type === 'MemberExpression' && !callee.computed && !callee.optional && callee.object.type === 'Identifier' && callee.object.name === 'Object' && callee.property.name === 'freeze';

  return isFreeze && init.arguments.length === 1 ? init.arguments[0] : init;
}

/**
 * @param {SyntaxNode | null} node An element of an array literal or the value of a property, or null for a hole.
 * @returns {boolean} True for a string literal, or a template literal with no expression, of 1 or more characters.
 */
function isEndStateString(node) {
  if (node?.type === 'Literal') return typeof node.value === 'string' && node.value !== '';
  return node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis[0].value.cooked !== '';
}

/**
 * @param {SyntaxNode} node A node that isEndStateString accepts.
 * @returns {string}
 */
function readStringValue(node) {
  return node.type === 'Literal' ? node.value : node.quasis[0].value.cooked;
}
