// The runtime runs the body inside an async function (Claude Code 2.1.332), so a top-level return and await parse.
// A probe parsed seven production workflow scripts of 20 KB to 344 KB with these options.
export const PARSE_OPTIONS = Object.freeze({
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
});

/**
 * Gives acorn's reason for a syntax error without the line and column it appends, which a finding states.
 * @param {SyntaxError} error
 * @returns {string}
 */
export function formatSyntaxErrorReason(error) {
  return error.message.replace(/ \(\d+:\d+\)$/, '');
}
