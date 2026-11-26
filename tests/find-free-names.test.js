import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'acorn';
import { findFreeNames, listFreeReferences } from '../src/find-free-names.js';

/**
 * @param {string} text
 * @returns {string[]}
 */
function listFreeNames(text) {
  const program = parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
  return findFreeNames(program).map((identifier) => identifier.name);
}

describe('findFreeNames', () => {
  it('finds each name that no scope declares, once, in source order', () => {
    assert.deepEqual(listFreeNames('log(a);\nfunction f() { return [b, a, log]; }\n'), ['log', 'a', 'b']);
  });

  it('skips names that the file declares at its top level or in an inner scope', () => {
    const text = [
      "import d, { e as f } from './a.js';",
      'export const g = 1;',
      'export default function h() {}',
      'var i;',
      'function j(k, { l } = {}) { var m; return [d, f, g, h, i, k, l, m, arguments]; }',
      'try {} catch (n) { n; }',
      'const o = class p { q() { return p; } };',
      'for (const r of []) r;',
      '{ let s; s; }',
    ].join('\n');

    assert.deepEqual(listFreeNames(text), []);
  });

  it('skips property names, keys, labels, meta properties, export names and import attribute keys', () => {
    const text = [
      "import k from './k.json' with { type: 'json' };",
      'const a = {};',
      'a.b;',
      'const c = { d: 1, e() {}, [a]: 2 };',
      'class F { g = 1; h() {} }',
      'label: for (;;) { break label; }',
      'function i() { return new.target; }',
      'export { a as j };',
      "export { l as m, n } from './n.js';",
    ].join('\n');

    assert.deepEqual(listFreeNames(text), []);
  });

  it('finds a name read in a computed key, a default value and a shorthand property', () => {
    assert.deepEqual(listFreeNames('const a = { [b]: 1, c };\nfunction d(e = f) {}\n'), ['b', 'c', 'f']);
  });
});

describe('listFreeReferences', () => {
  it('lists every reference to an undeclared name, in source order', () => {
    const program = parse('b(a);\nfunction f(a) { return [a, b]; }\n', { ecmaVersion: 'latest', sourceType: 'module' });
    const references = listFreeReferences(program);

    assert.deepEqual(references.map((identifier) => `${identifier.name}@${identifier.start}`), ['b@0', 'a@2', 'b@33']);
  });
});
