import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeObjectKind, findNonJsonValue, isPlainObject } from '../src/find-non-json-value.js';

describe('findNonJsonValue', () => {
  it('finds nothing in JSON values', () => {
    assert.equal(findNonJsonValue({ text: 'a', list: [1, null, true, { nested: -1.5 }] }), null);
    assert.equal(findNonJsonValue(Object.assign(Object.create(null), { a: 1 })), null);
    assert.equal(findNonJsonValue('text'), null);
  });

  it('finds each kind of value JSON cannot carry, with the path to it', () => {
    const cyclic = { list: [] };
    cyclic.list.push(cyclic);

    assert.deepEqual(findNonJsonValue(() => 1), { path: '', kind: 'a function' });
    assert.deepEqual(findNonJsonValue({ a: { b: [0, undefined] } }), { path: 'a.b[1]', kind: 'undefined' });
    assert.deepEqual(findNonJsonValue({ 'two words': 1n }), { path: '["two words"]', kind: 'a BigInt' });
    assert.deepEqual(findNonJsonValue({ 'joined‍key': 1n }), { path: '["joined\\u{200D}key"]', kind: 'a BigInt' });
    assert.deepEqual(findNonJsonValue([Symbol('s')]), { path: '[0]', kind: 'a symbol' });
    assert.deepEqual(findNonJsonValue({ score: Infinity }), { path: 'score', kind: 'the number Infinity' });
    assert.deepEqual(findNonJsonValue(cyclic), { path: 'list[0]', kind: 'a cycle' });
    assert.deepEqual(findNonJsonValue({ at: new Date(0) }), { path: 'at', kind: 'a Date' });
    assert.deepEqual(findNonJsonValue([1, , 2]), { path: '[1]', kind: 'undefined' });
  });

  it('counts an object seen twice outside a cycle as JSON', () => {
    const shared = { a: 1 };

    assert.equal(findNonJsonValue([shared, shared]), null);
  });
});

describe('the kind of an object', () => {
  it('names a plain object, an array, a class instance and a built-in object', () => {
    class Record {}

    assert.equal(describeObjectKind({}), 'an object');
    assert.equal(describeObjectKind([]), 'an array');
    assert.equal(describeObjectKind(new Record()), 'an object of a class');
    assert.equal(describeObjectKind(new Map()), 'a Map');
    assert.equal(describeObjectKind(new Error('x')), 'an Error');
    assert.equal(describeObjectKind(new Uint8Array(1)), 'a Uint8Array');
    assert.equal(isPlainObject(new Record()), false);
  });
});
