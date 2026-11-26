import { parse } from 'acorn';
import { PARSE_OPTIONS } from './parse-source.js';

/**
 * @typedef {object} Directive
 * @property {string} path The path the directive names, relative to the entry's folder.
 * @property {number} offset The offset of the directive's comment.
 * @property {number} start The offset of the directive's line.
 * @property {number} end The offset just after the line's line break, or the text's length when it has none.
 */

/**
 * @typedef {object} MisplacedDirective
 * @property {number} offset
 * @property {string} message
 */

const INCLUDE_COMMENT = /^\s*@include(?=\s|$)/;

/**
 * Whether a comment reads `// @include`, such as `// @include ./part.js`. A `// @included` comment does not.
 * @param {import('acorn').Comment} comment
 * @returns {boolean}
 */
export function isIncludeComment(comment) {
  return comment.type === 'Line' && INCLUDE_COMMENT.test(comment.value);
}

/**
 * Reads the directives of an entry: each `// @include` line comment alone on its line, at the top level and
 * below the meta statement. Acorn reports no comment inside a template literal or a string, so a
 * `// @include` line in a prompt stays text.
 * @param {string} text The normalized text of the entry.
 * @returns {{ directives: Directive[], misplaced: MisplacedDirective[] }} Both empty when the entry does not
 *   parse, since its analysis reports the syntax error.
 */
export function findDirectives(text) {
  const directives = [];
  const misplaced = [];
  const comments = [];
  let program = null;

  // Every `// @include` comment holds this text, so an entry without it needs no second parse.
  if (!text.includes('@include')) return { directives, misplaced };
  try {
    program = parse(text, { ...PARSE_OPTIONS, onComment: comments });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { directives, misplaced };
  }

  const metaEnd = program.body[0]?.end ?? text.length;
  for (const comment of comments.filter(isIncludeComment)) {
    const start = text.lastIndexOf('\n', comment.start - 1) + 1;
    const lineBreak = text.indexOf('\n', comment.end);
    const lineEnd = lineBreak === -1 ? text.length : lineBreak;
    const end = lineBreak === -1 ? text.length : lineBreak + 1;
    // Acorn ends a line comment at U+2028 or U+2029 too, where code can follow on the same line.
    const isAlone = text.slice(start, comment.start).trim() === '' && comment.end === lineEnd;
    const isInsideStatement = program.body.some((statement) => statement.start < comment.start && comment.start < statement.end);
    const addMisplaced = (message) => misplaced.push({ offset: comment.start, message });

    if (!isAlone) {
      addMisplaced('The // @include comment shares its line with code');
    } else if (isInsideStatement) {
      addMisplaced('The // @include comment sits inside a statement, below the top level of the entry');
    } else if (comment.start < metaEnd) {
      addMisplaced('The // @include comment sits above the end of the meta statement');
    } else {
      const path = comment.value.replace(INCLUDE_COMMENT, '').trim();
      directives.push({ path, offset: comment.start, start, end });
    }
  }

  return { directives, misplaced };
}
