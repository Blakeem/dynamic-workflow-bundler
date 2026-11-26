import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPart } from '../src/check-part.js';

/**
 * @param {string} text
 * @returns {string[]} Each finding as `<rule> <line>:<column> <message>`.
 */
function listFindings(text) {
  return checkPart(text, '/work/part.js').map((finding) => `${finding.rule} ${finding.line}:${finding.column} ${finding.message}`);
}

describe('checkPart', () => {
  it('passes statements with a top-level return and await', () => {
    assert.deepEqual(listFindings('const done = await agent("x");\nif (!done) return null;\n'), []);
  });

  it('reports part-not-plain in place of syntax-error for a part that does not parse on its own', () => {
    assert.deepEqual(listFindings('const = 1;\n'), ['part-not-plain 1:7 Unexpected token']);
    assert.deepEqual(listFindings('#!/usr/bin/env node\nlog(1);\n'), ["part-not-plain 1:2 Unexpected character '!'"]);
  });

  it('reports part-not-plain for each import and export, and include-misplaced for a // @include comment', () => {
    assert.deepEqual(listFindings("import './a.js';\nexport const a = 1;\nexport default 2;\n// @include ./b.js\n"), [
      'part-not-plain 1:1 The part holds an import',
      'part-not-plain 2:1 The part holds an export',
      'part-not-plain 3:1 The part holds an export',
      'include-misplaced 4:1 The part holds a // @include comment, which only the entry may hold',
    ]);
  });
});
