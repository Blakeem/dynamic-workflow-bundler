import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'acorn';
import { formatSyntaxErrorReason, isStackSpaceError, PARSE_OPTIONS } from '../src/parse-source.js';

describe('PARSE_OPTIONS', () => {
  it('parses a top-level return and await, as the runtime body allows', () => {
    assert.doesNotThrow(() => parse('await 1;\nreturn 2;\n', PARSE_OPTIONS));
  });
});

describe('formatSyntaxErrorReason', () => {
  it('drops the line and column that acorn appends', () => {
    let reason = '';
    try {
      parse('const = 1;', PARSE_OPTIONS);
    } catch (error) {
      reason = formatSyntaxErrorReason(error);
    }

    assert.equal(reason, 'Unexpected token');
  });

  it('names each character a terminal does not show by U+ and its code point, and keeps every other character', () => {
    // Each case is a code point that acorn refuses, and the reason formatSyntaxErrorReason gives for it.
    const cases = [
      [0x0, "Unexpected character 'U+0000'"],
      [0x1b, "Unexpected character 'U+001B'"],
      [0x200b, "Unexpected character 'U+200B'"],
      [0x1d173, "Unexpected character 'U+1D173'"],
      [0xa7, `Unexpected character '${String.fromCodePoint(0xa7)}'`],
    ];
    const reasons = [];
    for (const [codePoint] of cases) {
      try {
        parse(String.fromCodePoint(codePoint), PARSE_OPTIONS);
      } catch (error) {
        reasons.push(formatSyntaxErrorReason(error));
      }
    }

    assert.deepEqual(reasons, cases.map(([, reason]) => reason));
  });

  it('names a line separator and a paragraph separator by their code points', () => {
    const message = `Unexpected character '${String.fromCodePoint(0x2028, 0x2029)}' (1:0)`;

    assert.equal(formatSyntaxErrorReason(new SyntaxError(message)), "Unexpected character 'U+2028U+2029'");
  });
});

describe('isStackSpaceError', () => {
  it('is true for the error of valid code nested past the parser stack, and false for a syntax error', () => {
    const depth = 1200;
    const errors = [];
    for (const text of [`const v = ${'{ a: '.repeat(depth)}1${' }'.repeat(depth)};\n`, 'const = 1;']) {
      try {
        parse(text, PARSE_OPTIONS);
      } catch (error) {
        errors.push(error);
      }
    }

    assert.deepEqual(errors.map(isStackSpaceError), [true, false]);
  });
});
