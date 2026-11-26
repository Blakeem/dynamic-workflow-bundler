import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as library from 'dynamic-workflow-bundler';
import { build } from '../src/build.js';

describe('package entry', () => {
  it('exports build and nothing else', () => {
    assert.deepEqual(Object.keys(library), ['build']);
    assert.equal(library.build, build);
  });
});
