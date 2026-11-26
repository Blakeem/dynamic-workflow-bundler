import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findDirectives, isIncludeComment } from '../src/find-directives.js';
import { DEEP_REGEXP_LITERAL } from './support/deep-regexp-literal.js';

describe('isIncludeComment', () => {
  it('reads a line comment that starts with @include, and no other comment', () => {
    const comment = (type, value) => ({ type, value, start: 0, end: 0 });

    assert.equal(isIncludeComment(comment('Line', ' @include ./a.js')), true);
    assert.equal(isIncludeComment(comment('Line', '@include')), true);
    assert.equal(isIncludeComment(comment('Line', ' @included by ./a.js')), false);
    assert.equal(isIncludeComment(comment('Line', ' see @include')), false);
    assert.equal(isIncludeComment(comment('Block', ' @include ./a.js ')), false);
  });
});

describe('findDirectives', () => {
  it('reads each directive alone on its line at the top level below the meta statement, with its line range', () => {
    const text = 'export const meta = {};\n// @include ./a.js\n  // @include  parts/b.js  \nreturn 1;\n// @include ./c.js';
    const { directives, misplaced } = findDirectives(text);

    assert.deepEqual(misplaced, []);
    assert.deepEqual(
      directives.map(({ path, start, end }) => [path, text.slice(start, end)]),
      [
        ['./a.js', '// @include ./a.js\n'],
        ['parts/b.js', '  // @include  parts/b.js  \n'],
        ['./c.js', '// @include ./c.js'],
      ],
    );
  });

  it('reports a // @include comment that shares its line, sits inside a statement or sits above the end of meta', () => {
    const text = [
      '// @include ./above.js',
      'export const meta = {',
      '  // @include ./inside-meta.js',
      '};',
      'run(); // @include ./shared.js',
      'function run() {',
      '  // @include ./inside.js',
      '}',
      '// @include ./a.js run();',
      '',
    ].join('\n');

    assert.deepEqual(findDirectives(text).misplaced.map(({ message }) => message), [
      'The // @include comment sits above the end of the meta statement',
      'The // @include comment sits inside a statement, below the top level of the entry',
      'The // @include comment shares its line with code',
      'The // @include comment sits inside a statement, below the top level of the entry',
      'The // @include comment shares its line with code',
    ]);
    assert.deepEqual(findDirectives(text).directives, []);
  });

  it('leaves a // @include line inside a template literal as text', () => {
    assert.deepEqual(findDirectives('export const meta = {};\nconst p = `\n// @include ./a.js\n`;\n'), { directives: [], misplaced: [] });
  });

  it('reads nothing from an entry that does not parse, whose analysis reports the syntax error', () => {
    assert.deepEqual(findDirectives('export const meta = {};\n// @include ./a.js\nconst = 1;\n'), { directives: [], misplaced: [] });
  });

  it('reads nothing from an entry whose first token is nested past the parser stack', () => {
    assert.deepEqual(findDirectives(`${DEEP_REGEXP_LITERAL};\n// @include ./a.js\n`), { directives: [], misplaced: [] });
  });
});
