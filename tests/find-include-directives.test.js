import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findIncludeDirectives, isIncludeComment } from '../src/find-include-directives.js';
import { DEEP_REGEXP_LITERAL } from './support/deep-regexp-literal.js';

describe('isIncludeComment', () => {
  it('reads a line comment that starts with @include, and no other comment', () => {
    const isLineInclude = (value) => isIncludeComment({ type: 'Line', value, start: 0, end: value.length + 2 }, `//${value}`);

    assert.equal(isLineInclude(' @include ./a.js'), true);
    assert.equal(isLineInclude('@include'), true);
    assert.equal(isLineInclude(' @included by ./a.js'), false);
    assert.equal(isLineInclude(' see @include'), false);
    assert.equal(isIncludeComment({ type: 'Block', value: ' @include ./a.js ', start: 0, end: 21 }, '/* @include ./a.js */'), false);
  });

  it('reads no #! line, which acorn reports as a line comment', () => {
    assert.equal(isIncludeComment({ type: 'Line', value: ' @include ./a.js', start: 0, end: 18 }, '#! @include ./a.js'), false);
  });
});

describe('findIncludeDirectives', () => {
  it('reads each directive alone on its line at the top level below the meta statement, with its line range', () => {
    const text = 'export const meta = {};\n// @include ./a.js\n  // @include  parts/b.js  \nreturn 1;\n// @include ./c.js';
    const { directives, misplaced } = findIncludeDirectives(text);

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
      '// @include ./a.js\u2028run();',
      '',
    ].join('\n');

    assert.deepEqual(findIncludeDirectives(text).misplaced.map(({ message }) => message), [
      'The // @include comment sits above the end of the meta statement',
      'The // @include comment sits inside a statement, below the top level of the entry',
      'The // @include comment shares its line with code',
      'The // @include comment sits inside a statement, below the top level of the entry',
      'The // @include comment shares its line with code',
    ]);
    assert.deepEqual(findIncludeDirectives(text).directives, []);
  });

  it('reads no directive and no misplaced comment from a #! line at the start of the entry', () => {
    assert.deepEqual(findIncludeDirectives('#! @include ./p.js\nexport const meta = {};\n'), { directives: [], misplaced: [] });
  });

  it('leaves a // @include line inside a template literal as text', () => {
    assert.deepEqual(findIncludeDirectives('export const meta = {};\nconst p = `\n// @include ./a.js\n`;\n'), { directives: [], misplaced: [] });
  });

  it('reads nothing from an entry that does not parse, whose analysis reports the syntax error', () => {
    assert.deepEqual(findIncludeDirectives('export const meta = {};\n// @include ./a.js\nconst = 1;\n'), { directives: [], misplaced: [] });
  });

  it('reads nothing from an entry whose first token is nested past the parser stack', () => {
    assert.deepEqual(findIncludeDirectives(`${DEEP_REGEXP_LITERAL};\n// @include ./a.js\n`), { directives: [], misplaced: [] });
  });
});
