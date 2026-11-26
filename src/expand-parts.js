import { countLineBreaks } from './source-position.js';

/**
 * @typedef {object} PartReplacement
 * @property {string} file The part's real path.
 * @property {string} text The part's normalized text.
 * @property {number} start The offset of the directive's line in the entry's own text.
 * @property {number} end The offset just after that line.
 */

/**
 * @typedef {object} IncludedPart
 * @property {string} file The part's real path.
 * @property {number} start The offset of the part's text in the expanded entry text.
 * @property {number} end The offset just after the part's text there.
 * @property {number} firstLine The 1-based line of the expanded entry text that holds the part's first line.
 * @property {number} lineCount
 * @property {number} directiveStart The offset of the directive's line in the entry's own text.
 * @property {number} directiveEnd The offset just after that line.
 */

/**
 * Puts each part's text in place of its directive's line. A part that does not end in a line break gets
 * one, so the line after the directive keeps its own line.
 * @param {string} text The entry's own normalized text.
 * @param {PartReplacement[]} replacements In source order.
 * @returns {{ text: string, includes: IncludedPart[] }}
 */
export function expandParts(text, replacements) {
  const pieces = [];
  const includes = [];
  let position = 0;
  let expandedLength = 0;
  let lineCount = 1;

  for (const replacement of replacements) {
    const before = text.slice(position, replacement.start);
    const partText = replacement.text.endsWith('\n') ? replacement.text : `${replacement.text}\n`;
    const partLineCount = countLineBreaks(partText);
    lineCount += countLineBreaks(before);
    expandedLength += before.length;
    includes.push({
      file: replacement.file,
      start: expandedLength,
      end: expandedLength + partText.length,
      firstLine: lineCount,
      lineCount: partLineCount,
      directiveStart: replacement.start,
      directiveEnd: replacement.end,
    });
    pieces.push(before, partText);
    lineCount += partLineCount;
    expandedLength += partText.length;
    position = replacement.end;
  }
  pieces.push(text.slice(position));

  return { text: pieces.join(''), includes };
}

/**
 * @param {IncludedPart[]} includes
 * @param {number} offset An offset of the entry's own text outside every expanded directive line.
 * @returns {number} The same place's offset in the expanded entry text.
 */
export function findExpandedOffset(includes, offset) {
  let expandedOffset = offset;

  for (const include of includes) {
    if (include.directiveEnd > offset) break;
    expandedOffset += include.end - include.start - (include.directiveEnd - include.directiveStart);
  }

  return expandedOffset;
}

/**
 * Gives the source file and line that a line of the expanded entry text comes from.
 * @param {IncludedPart[]} includes
 * @param {number} line 1-based.
 * @returns {{ file: string | null, line: number }} `file` is a part's real path, or null for the entry.
 */
export function findLineOrigin(includes, line) {
  let addedLineCount = 0;

  for (const include of includes) {
    if (line < include.firstLine) break;
    if (line < include.firstLine + include.lineCount) return { file: include.file, line: line - include.firstLine + 1 };
    addedLineCount += include.lineCount - 1;
  }

  return { file: null, line: line - addedLineCount };
}
