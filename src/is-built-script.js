import { tokenizer } from 'acorn';
import { findBanner, isBannerText } from './banner.js';
import { readMetaObject } from './meta-statement.js';
import { PARSE_OPTIONS, parseSource } from './parse-source.js';
import { isStackOverflowError } from './syntax-tree.js';

// Git writes these lines around the two sides of a merge conflict, at its default conflict-marker-size of 7.
const FIRST_SIDE_START = /^<{7}(?: |$)/;
const OTHER_SIDE_START = /^(?:\|{7}(?: |$)|={7}$)/;
const CONFLICT_END = /^>{7}(?: |$)/;
const OUTSIDE_CONFLICT = 'outside';
const FIRST_SIDE = 'first';
const OTHER_SIDE = 'other';
const META_START = ['export', 'const', 'meta'];

/**
 * Tells whether a build may replace a file, since a build can write its script again and cannot restore a file
 * it did not write. Reads no disk.
 * @param {string} text The text of the file at `out`.
 * @param {boolean} banner Whether the build writes the banner line.
 * @returns {boolean} True for a text with a banner. True for a text that does not parse, such as a built script
 *   with a merge conflict marker, when the text with each conflict's other side left out opens with the meta
 *   statement, after comments only, and a later line opens with a banner line comment. With no banner, also true when
 *   the text, or for a text that does not parse the text with each conflict's other side left out, parses and has
 *   the meta statement as its first statement, since a script built with no banner holds no other mark.
 */
export function isBuiltScript(text, banner) {
  const { path, hasSyntaxError } = findBanner(text);
  let firstSideText = '';

  if (path !== null) return true;
  if (!hasSyntaxError) return !banner && hasMetaFirst(text);
  firstSideText = readFirstSideText(text);
  return hasBannerAfterMetaStart(firstSideText) || (!banner && hasMetaFirst(firstSideText));
}

/**
 * @param {string} text
 * @returns {boolean} True when the text parses and its first statement is the meta statement.
 */
function hasMetaFirst(text) {
  let program = null;

  try {
    program = parseSource(text, PARSE_OPTIONS);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return readMetaObject(program.body[0]) !== null;
}

/**
 * @param {string} text
 * @returns {string} The text with LF line ends, and with each conflict marker line and each line of a conflict's
 *   other side left out. A line of a marker's form outside a conflict, such as a setext heading in a template
 *   literal, stays.
 */
function readFirstSideText(text) {
  const lines = [];
  let place = OUTSIDE_CONFLICT;

  for (const line of text.split(/\r?\n/)) {
    if (FIRST_SIDE_START.test(line)) place = FIRST_SIDE;
    else if (place === FIRST_SIDE && OTHER_SIDE_START.test(line)) place = OTHER_SIDE;
    else if (place !== OUTSIDE_CONFLICT && CONFLICT_END.test(line)) place = OUTSIDE_CONFLICT;
    else if (place !== OTHER_SIDE) lines.push(line);
  }
  return lines.join('\n');
}

/**
 * A text that does not parse has no syntax tree, so its tokens tell a banner comment from a banner line quoted
 * in a string or a template literal.
 * @param {string} text
 * @returns {boolean} True when the first tokens are `export const meta` and a later line comment that starts
 *   a line is a banner. False for a text that the tokenizer refuses.
 */
function hasBannerAfterMetaStart(text) {
  const comments = [];
  const firstTokens = [];

  try {
    for (const token of tokenizer(text, { ...PARSE_OPTIONS, onComment: comments })) {
      if (firstTokens.length < META_START.length) firstTokens.push(token);
    }
  } catch (error) {
    if (error instanceof SyntaxError || isStackOverflowError(error)) return false;
    throw error;
  }
  // The source text, not the token value, so that a string such as 'meta' is no meta keyword.
  if (!META_START.every((word, index) => firstTokens[index] !== undefined && text.slice(firstTokens[index].start, firstTokens[index].end) === word)) return false;
  return comments.some((comment) => comment.type === 'Line' && comment.start > firstTokens[0].start && text[comment.start - 1] === '\n' && isBannerText(text.slice(comment.start, comment.end)));
}
