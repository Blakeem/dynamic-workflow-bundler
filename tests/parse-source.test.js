import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Parser, parse } from 'acorn';
import { formatSyntaxErrorReason, isStackSpaceError, PARSE_OPTIONS, parseSource } from '../src/parse-source.js';
import { DEEP_REGEXP_LITERAL } from './support/deep-regexp-literal.js';

describe('PARSE_OPTIONS', () => {
  it('parses a top-level return and await, as the runtime body allows', () => {
    assert.doesNotThrow(() => parse('await 1;\nreturn 2;\n', PARSE_OPTIONS));
  });
});

describe('parseSource', () => {
  it('gives the stack space error at offset 0 for a first token that overflows the stack', () => {
    assert.throws(() => parseSource(`${DEEP_REGEXP_LITERAL};\n`, PARSE_OPTIONS), (error) => error instanceof SyntaxError && isStackSpaceError(error) && error.pos === 0);
  });

  it('parses with the parser class it is given, and rethrows a syntax error as it is', () => {
    const NamedParser = Parser.extend((BaseParser) => class extends BaseParser {
      parseTopLevel(node) {
        node.parsedBy = 'NamedParser';
        return super.parseTopLevel(node);
      }
    });

    assert.equal(parseSource('return 1;\n', PARSE_OPTIONS, NamedParser).parsedBy, 'NamedParser');
    assert.throws(() => parseSource('const = 1;', PARSE_OPTIONS), (error) => error instanceof SyntaxError && formatSyntaxErrorReason(error) === 'Unexpected token' && error.pos === 6);
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

  it('names each character a terminal does not show by its JavaScript escape, and keeps every other character', () => {
    // Each case is a code point that acorn refuses, and the reason formatSyntaxErrorReason gives for it.
    const cases = [
      [0x0, "Unexpected character '\\u{0000}'"],
      [0x1b, "Unexpected character '\\u{001B}'"],
      [0x200b, "Unexpected character '\\u{200B}'"],
      [0x1d173, "Unexpected character '\\u{1D173}'"],
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

  it('names a line separator and a paragraph separator by their JavaScript escapes', () => {
    const message = `Unexpected character '${String.fromCodePoint(0x2028, 0x2029)}' (1:0)`;

    assert.equal(formatSyntaxErrorReason(new SyntaxError(message)), "Unexpected character '\\u{2028}\\u{2029}'");
  });

  it('ends the escape of a joiner inside an identifier before a hex digit that follows it', () => {
    let reason = '';
    try {
      parse('const A\u200DB = 1;\nlet A\u200DB = 2;\n', PARSE_OPTIONS);
    } catch (error) {
      reason = formatSyntaxErrorReason(error);
    }

    assert.equal(reason, "Identifier 'A\\u{200D}B' has already been declared");
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
