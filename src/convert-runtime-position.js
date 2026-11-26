import { countLines, findPosition } from './source-position.js';
import { UsageError } from './usage-error.js';

const CODE_START_PATTERN = /[^\s;]/;
// Node.js 24.22.1 numbers stack trace lines at U+2028 and U+2029 too. The runtime was not measured.
const OTHER_LINE_TERMINATOR_PATTERN = /[\u2028\u2029]/;

/**
 * Converts a line and column that the runtime reports, as in a stack trace, to the built script's own.
 * A probe under Claude Code 2.1.332 found runtime line R on script line R + F - 2, where F is the line of the
 * first character after the meta statement that is not whitespace or a semicolon. The column is the same,
 * apart from line F, where the runtime drops the text before that character.
 * Throws a UsageError for a runtime line below 2, for a script with nothing after its meta statement, and for
 * a script that holds U+2028 or U+2029 above the line, since the runtime may number lines at those characters.
 * A runtime line past the script's end gives a line past its end, which the caller checks.
 * @param {string} script
 * @param {number} metaEnd The offset just after the meta statement.
 * @param {number} runtimeLine 1-based.
 * @param {number} runtimeColumn 1-based.
 * @returns {{ line: number, column: number }} The script's 1-based line and column.
 */
export function convertRuntimePosition(script, metaEnd, runtimeLine, runtimeColumn) {
  const codeIndex = script.slice(metaEnd).search(CODE_START_PATTERN);

  if (codeIndex === -1) throw new UsageError('The script holds nothing after its meta statement, so the runtime reports no line of it');
  if (runtimeLine < 2) throw new UsageError(`The runtime line ${runtimeLine} holds no line of the script, since the runtime starts the script's code on its line 2`);
  const codeStart = findPosition(script, metaEnd + codeIndex);
  const line = runtimeLine + codeStart.line - 2;
  const column = runtimeLine === 2 ? runtimeColumn + codeStart.column - 1 : runtimeColumn;
  if (line > countLines(script)) return { line, column };
  const textAboveLine = script.slice(metaEnd, script.split('\n', line - 1).join('\n').length);
  if (OTHER_LINE_TERMINATOR_PATTERN.test(textAboveLine)) {
    throw new UsageError(`The script holds U+2028 or U+2029 above line ${line}, which the runtime may number as a line break, so the runtime line cannot be converted`);
  }

  return { line, column };
}
