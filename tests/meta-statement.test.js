import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'acorn';
import { readMetaObject } from '../src/meta-statement.js';
import { PARSE_OPTIONS } from '../src/parse-source.js';

/**
 * @param {string} text
 * @returns {string | null} The text of the meta object that the first statement holds, or null.
 */
function readFirstMetaText(text) {
  const metaObject = readMetaObject(parse(text, PARSE_OPTIONS).body[0]);
  return metaObject === null ? null : text.slice(metaObject.start, metaObject.end);
}

describe('readMetaObject', () => {
  it('reads the object of export const meta, with or without parentheses', () => {
    assert.equal(readFirstMetaText("export const meta = { name: 'p' };\n"), "{ name: 'p' }");
    assert.equal(readFirstMetaText("export const meta = ({ name: 'p' });\n"), "{ name: 'p' }");
  });

  it('gives null for each statement of another form', () => {
    for (const text of ['export let meta = {};', 'export var meta = {};', 'const meta = {};', 'export const meta = {}, other = 1;', 'export const meta = [];', 'export const other = {};', 'return 1;']) {
      assert.equal(readFirstMetaText(text), null, text);
    }
    assert.equal(readMetaObject(undefined), null);
  });
});
