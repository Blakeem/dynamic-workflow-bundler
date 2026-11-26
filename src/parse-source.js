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

/**
 * Gives acorn's reason for a syntax error without the line and column it appends, which a finding states.
 * @param {SyntaxError} error
 * @returns {string}
 */
export function formatSyntaxErrorReason(error) {
  return error.message.replace(/ \(\d+:\d+\)$/, '');
}

/**
 * @param {SyntaxError} error
 * @returns {boolean} True for acorn's error for its own stack overflow, which says nothing about the syntax.
 */
export function isStackSpaceError(error) {
  return formatSyntaxErrorReason(error) === STACK_SPACE_REASON;
}
