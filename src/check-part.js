import { parse } from 'acorn';
import { createFinding } from './finding.js';
import { isIncludeComment } from './find-directives.js';
import { formatSyntaxErrorReason, PARSE_OPTIONS } from './parse-source.js';

/** @typedef {import('./finding.js').Finding} Finding */

// A #! line is legal only at the start of a script, and a part sits below the meta statement.
const PART_PARSE_OPTIONS = Object.freeze({ ...PARSE_OPTIONS, allowHashBang: false });
const MODULE_STATEMENT_TYPES = new Map([
  ['ImportDeclaration', 'The part holds an import'],
  ['ExportNamedDeclaration', 'The part holds an export'],
  ['ExportDefaultDeclaration', 'The part holds an export'],
  ['ExportAllDeclaration', 'The part holds an export'],
]);

/**
 * Checks that a part parses on its own as a list of statements, with no import, no export and no
 * `// @include` comment. The entry's analysis checks the rest once the part sits in the entry's text.
 * @param {string} text The normalized text of the part.
 * @param {string} file
 * @returns {Finding[]} In source order.
 */
export function checkPart(text, file) {
  const findings = [];
  const comments = [];
  const addFinding = (rule, message, offset) => findings.push(createFinding(rule, message, file, text, offset));
  let program = null;

  try {
    program = parse(text, { ...PART_PARSE_OPTIONS, onComment: comments });
  } catch (error) {
    if (!(error instanceof SyntaxError) || typeof error.pos !== 'number') throw error;
    addFinding('part-not-plain', formatSyntaxErrorReason(error), error.pos);
    return findings;
  }

  for (const statement of program.body) {
    if (MODULE_STATEMENT_TYPES.has(statement.type)) addFinding('part-not-plain', MODULE_STATEMENT_TYPES.get(statement.type), statement.start);
  }
  for (const comment of comments.filter(isIncludeComment)) {
    addFinding('include-misplaced', 'The part holds a // @include comment, which only the entry may hold', comment.start);
  }

  findings.sort((first, second) => first.line - second.line || first.column - second.column);
  return findings;
}
