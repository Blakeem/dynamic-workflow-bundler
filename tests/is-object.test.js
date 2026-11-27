import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isObject } from '../src/is-object.js';

describe('isObject', () => {
  it('is true for an object that is not null and not an array', () => {
    const objects = [{}, { a: 1 }, Object.create(null), new Map(), new Date(0)];

    assert.deepEqual(objects.filter((value) => !isObject(value)), []);
  });

  it('is false for null, an array, a function and every primitive', () => {
    const others = [null, undefined, [], [1], () => {}, 'text', '', 0, 1n, true, Symbol('s')];

    assert.deepEqual(others.filter(isObject), []);
  });
});
