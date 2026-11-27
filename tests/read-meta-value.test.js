import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PARSE_OPTIONS, parseSource } from '../src/parse-source.js';
import { readMetaValue } from '../src/read-meta-value.js';

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function readText(text) {
  return readMetaValue(parseSource(text, PARSE_OPTIONS));
}

describe('readMetaValue', () => {
  it('gives the value of each literal kind of a meta object', () => {
    const text = "export const meta = { name: 'p', 'description': `d`, 3: -1.5, flag: true, none: null, phases: [{ title: 'Dev', detail: 'Builds.' }], name: 'q' };\nreturn 1;\n";

    assert.deepEqual(readText(text), { 3: -1.5, name: 'q', description: 'd', flag: true, none: null, phases: [{ title: 'Dev', detail: 'Builds.' }] });
  });

  it('gives null for a script that does not open with a meta statement', () => {
    assert.equal(readText('const meta = { name: "p" };\n'), null);
    assert.equal(readText(''), null);
  });

  it('names a node that the meta-not-literal rule refuses', () => {
    assert.throws(() => readText('export const meta = { name: p };\n'), { message: 'The meta object holds a node of type Identifier, which the meta-not-literal rule refuses' });
  });
});
