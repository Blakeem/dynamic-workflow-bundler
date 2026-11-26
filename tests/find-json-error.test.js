import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkJsonFile, findJsonError } from '../src/find-json-error.js';

describe('findJsonError', () => {
  it('finds nothing in valid JSON', () => {
    for (const text of ['{}', '[]', ' { "a": [1, -2.5e3, "x\\u00e9\\n", true, false, null, {}] } \n', '" "', '0', '[[[[]]]]']) {
      assert.equal(findJsonError(text), null, text);
    }
  });

  it('gives the offset and the reason of the first place that breaks the grammar', () => {
    const cases = [
      ['', 0, 'Expected a value'],
      ['{a}', 1, 'Expected a property name in double quotes'],
      ['{"a":1,}', 7, 'Expected a property name in double quotes'],
      ['[1,]', 3, 'Expected a value'],
      ['[1 2]', 3, 'Expected a comma or a ] after an array element'],
      ['{"a" 1}', 5, 'Expected a colon after the property name'],
      ['{"a":1', 6, 'Expected a comma or a } after a property value'],
      ['{"a":1}x', 7, 'Expected the end of the file after the JSON value'],
      ['[01]', 2, 'Expected a comma or a ] after an array element'],
      ['-', 1, 'Expected a digit after the minus sign'],
      ['tru', 0, 'Expected a value'],
      ["'a'", 0, 'Expected a value'],
      ['"abc', 0, 'The string does not end'],
      ['"a\nb"', 2, 'The string holds a control character, such as a line break'],
      ['"\\q"', 1, 'The string holds an escape that JSON does not allow'],
      ['"\\u12"', 1, 'The string holds an escape that JSON does not allow'],
    ];

    for (const [text, offset, reason] of cases) {
      assert.throws(() => JSON.parse(text), SyntaxError, text);
      assert.deepEqual(findJsonError(text), { offset, reason }, text);
    }
  });

  it('reads a deep nesting without a stack overflow', () => {
    assert.deepEqual(findJsonError('['.repeat(200000)), { offset: 200000, reason: 'Expected a value' });
  });
});

describe('checkJsonFile', () => {
  it('reports json-invalid at the line and column of the error, and nothing for valid JSON', () => {
    assert.deepEqual(checkJsonFile('{ "a": 1 }\n', '/work/a.json'), []);
    assert.deepEqual(checkJsonFile('{\n  "a": 1,\n}\n', '/work/a.json'), [
      {
        rule: 'json-invalid',
        message: 'Expected a property name in double quotes',
        fix: 'Correct the JSON',
        file: '/work/a.json',
        line: 3,
        column: 1,
      },
    ]);
  });
});
