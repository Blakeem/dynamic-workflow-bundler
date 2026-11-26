import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'acorn';
import { formatSyntaxErrorReason, PARSE_OPTIONS } from '../src/parse-source.js';

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
});
