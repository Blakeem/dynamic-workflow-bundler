const GROUP_DEPTH = 100000;

/** A regular expression literal whose groups nest deep enough to overflow acorn 8.19.0's recursive validator on Node.js 24.22.1. */
export const DEEP_REGEXP_LITERAL = `/${'('.repeat(GROUP_DEPTH)}${')'.repeat(GROUP_DEPTH)}/`;
