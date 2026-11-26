import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as library from 'dynamic-workflow-bundler';
import { build } from '../src/build.js';
import { loadConfig } from '../src/load-config.js';

describe('package entry', () => {
  it('exports build and loadConfig and nothing else', () => {
    assert.deepEqual(Object.keys(library), ['build', 'loadConfig']);
    assert.equal(library.build, build);
    assert.equal(library.loadConfig, loadConfig);
  });
});
