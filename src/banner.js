import { parse } from 'acorn';
import { PARSE_OPTIONS } from './parse-source.js';

/** The banner comment's text before the entry's path. */
export const BANNER_START = '// Built by dynamic-workflow-bundler from ';
/** The banner comment's text after the entry's path. */
export const BANNER_END = '. Edit the source, not this file.';

/**
 * Reads the banner of a built script. The banner is a line comment that starts the line after the script's
 * first statement.
 * @param {string} script
 * @returns {{ path: string | null, hasSyntaxError: boolean }} The entry path as the banner holds it, relative
 *   to the script's folder, with each line terminator escaped. The path is null for a script with no banner
 *   and for a script that does not parse, which hasSyntaxError tells apart.
 */
export function findBanner(script) {
  const comments = [];
  let program = null;

  try {
    program = parse(script, { ...PARSE_OPTIONS, onComment: comments });
  } catch (error) {
    if (error instanceof SyntaxError) return { path: null, hasSyntaxError: true };
    throw error;
  }
  const firstStatement = program.body[0];
  const lineBreak = firstStatement === undefined ? -1 : script.indexOf('\n', firstStatement.end);
  const banner = lineBreak === -1 ? undefined : comments.find((comment) => comment.start === lineBreak + 1 && comment.type === 'Line');
  const bannerText = banner === undefined ? '' : script.slice(banner.start, banner.end);
  const isBanner = bannerText.length > BANNER_START.length + BANNER_END.length && bannerText.startsWith(BANNER_START) && bannerText.endsWith(BANNER_END);

  return { path: isBanner ? bannerText.slice(BANNER_START.length, -BANNER_END.length) : null, hasSyntaxError: false };
}
