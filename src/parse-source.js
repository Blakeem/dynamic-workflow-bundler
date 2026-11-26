import { Parser } from 'acorn';
import { isStackOverflowError } from './syntax-tree.js';

// The runtime runs the body inside an async function (Claude Code 2.1.332), so a top-level return and await parse.
// A probe parsed seven production workflow scripts of 20 KB to 344 KB with these options.
export const PARSE_OPTIONS = Object.freeze({
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
});
// Acorn 8.19.0 raises this reason for its own stack overflow, which valid code nested deep enough causes.
const STACK_SPACE_REASON = 'Not enough stack space to parse input';
/** The message of the source-too-deep finding for a source that acorn cannot parse. */
export const PARSER_DEPTH_MESSAGE = 'The file nests code deeper than the parser can read';
// Acorn quotes the character it refuses as it is, and a terminal shows none of these: the control and format
// characters, the line separator (Zl) and the paragraph separator (Zp).
const HIDDEN_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Parses a text with acorn, and gives acorn's stack space error for a stack overflow anywhere in the parse.
 * @param {string} text
 * @param {import('acorn').Options} options
 * @param {typeof Parser} [ParserClass] Acorn's Parser or a class that extends it.
 * @returns {import('acorn').Program}
 */
export function parseSource(text, options, ParserClass = Parser) {
  const parser = new ParserClass(options, text);

  try {
    return parser.parse();
  } catch (error) {
    // Acorn 8.19.0 reads the first token outside its own stack overflow guard.
    if (isStackOverflowError(error)) parser.raise(parser.start, STACK_SPACE_REASON);
    throw error;
  }
}

/**
 * Gives acorn's reason for a syntax error without the line and column it appends, which a finding states.
 * Each character a terminal does not show reads as U+ and its code point, such as U+0000.
 * @param {SyntaxError} error
 * @returns {string}
 */
export function formatSyntaxErrorReason(error) {
  const reason = error.message.replace(/ \(\d+:\d+\)$/, '');

  return reason.replace(HIDDEN_CHARACTER_PATTERN, (character) => `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

/**
 * @param {SyntaxError} error
 * @returns {boolean} True for acorn's error for its own stack overflow, which says nothing about the syntax.
 */
export function isStackSpaceError(error) {
  return formatSyntaxErrorReason(error) === STACK_SPACE_REASON;
}
