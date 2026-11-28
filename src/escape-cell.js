import { formatUnwritableCharacters } from './format-hidden-characters.js';

const WHITE_SPACE_RUN = /\s+/g;
const MARKDOWN_INLINE_MARK = /[\\`*_~[\]]/g;

/**
 * Writes the text of one Markdown table cell, so that a renderer shows the text as it is, on one line.
 * Markdown ends a table cell at `|`, reads `<` and `>` as the bounds of an HTML tag, reads `&<name>;` as an
 * entity, reads a backslash as an escape, and reads `` ` ``, `*`, `_`, `~`, `[` and `]` as inline marks, such as
 * a code span, in which no entity is decoded. GitHub reads `$...$` as inline math, and only an HTML tag around `$`
 * stops it, since a backslash or the entity `&#36;` does not (measured with the GitHub Markdown API in gfm mode).
 * A lone surrogate and a U+0000 are written as their escape, such as \u{D83D}, before the backslash escape.
 * @param {string} text
 * @returns {string}
 */
export function escapeCell(text) {
  // The tag goes in after the `&`, `<` and `>` escapes so that they leave it whole, and a replacer function keeps
  // `$` out of replacement-pattern parsing.
  return formatUnwritableCharacters(text).replace(WHITE_SPACE_RUN, ' ').trim().replace(MARKDOWN_INLINE_MARK, '\\$&').replaceAll('|', '\\|').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('$', () => '<span>$</span>');
}
