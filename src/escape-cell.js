const WHITE_SPACE_RUN = /\s+/g;
const MARKDOWN_INLINE_MARK = /[\\`*_~[\]]/g;

/**
 * Writes the text of one Markdown table cell, so that a renderer shows the text as it is, on one line.
 * Markdown ends a table cell at `|`, reads `<` and `>` as the bounds of an HTML tag, reads `&<name>;` as an
 * entity, reads a backslash as an escape, and reads `` ` ``, `*`, `_`, `~`, `[` and `]` as inline marks, such as
 * a code span, in which no entity is decoded.
 * @param {string} text
 * @returns {string}
 */
export function escapeCell(text) {
  return text.replace(WHITE_SPACE_RUN, ' ').trim().replace(MARKDOWN_INLINE_MARK, '\\$&').replaceAll('|', '\\|').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
