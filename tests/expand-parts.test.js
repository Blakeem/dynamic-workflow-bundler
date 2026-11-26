import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandParts, findExpandedOffset, findLineOrigin } from '../src/expand-parts.js';

const ENTRY = 'meta;\n// @include ./a.js\nmiddle;\n// @include ./b.js';

/**
 * @param {string} line The directive line, without its line break.
 * @returns {{ start: number, end: number }} The directive line's range in ENTRY, with its line break.
 */
function findLineRange(line) {
  const start = ENTRY.indexOf(line);
  return { start, end: Math.min(start + line.length + 1, ENTRY.length) };
}

const REPLACEMENTS = [
  { file: '/work/a.js', text: 'a1;\na2;\na3;\n', ...findLineRange('// @include ./a.js') },
  { file: '/work/b.js', text: 'b1;', ...findLineRange('// @include ./b.js') },
];

describe('expandParts', () => {
  it('puts each part in place of its directive line, and closes a part that does not end in a line break', () => {
    const { text, includes } = expandParts(ENTRY, REPLACEMENTS);

    assert.equal(text, 'meta;\na1;\na2;\na3;\nmiddle;\nb1;\n');
    assert.deepEqual(
      includes.map(({ file, start, end, firstLine, lineCount }) => [file, text.slice(start, end), firstLine, lineCount]),
      [
        ['/work/a.js', 'a1;\na2;\na3;\n', 2, 3],
        ['/work/b.js', 'b1;\n', 6, 1],
      ],
    );
  });

  it('leaves a text with no replacement as it is', () => {
    assert.deepEqual(expandParts(ENTRY, []), { text: ENTRY, includes: [] });
  });
});

describe('findLineOrigin', () => {
  it('maps each line of the expanded text to its part and line, or to the entry line', () => {
    const { includes } = expandParts(ENTRY, REPLACEMENTS);
    const origins = [1, 2, 3, 4, 5, 6].map((line) => findLineOrigin(includes, line));

    assert.deepEqual(origins, [
      { file: null, line: 1 },
      { file: '/work/a.js', line: 1 },
      { file: '/work/a.js', line: 2 },
      { file: '/work/a.js', line: 3 },
      { file: null, line: 3 },
      { file: '/work/b.js', line: 1 },
    ]);
  });
});

describe('findExpandedOffset', () => {
  it('moves an offset of the entry text below an expanded directive by the length the part adds', () => {
    const { text, includes } = expandParts(ENTRY, [REPLACEMENTS[0]]);
    const middle = ENTRY.indexOf('middle');
    const lastDirective = ENTRY.indexOf('// @include ./b.js');

    assert.equal(findExpandedOffset(includes, 0), 0);
    assert.equal(text.slice(findExpandedOffset(includes, middle)).startsWith('middle;'), true);
    assert.equal(text.slice(findExpandedOffset(includes, lastDirective)), '// @include ./b.js');
  });
});
