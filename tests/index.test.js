import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as library from 'dynamic-workflow-bundler';
import { build } from '../src/build.js';
import { loadConfig } from '../src/load-config.js';
import { locate } from '../src/locate.js';

describe('package entry', () => {
  it('exports build, loadConfig and locate and nothing else', () => {
    assert.deepEqual(Object.keys(library), ['build', 'loadConfig', 'locate']);
    assert.equal(library.build, build);
    assert.equal(library.loadConfig, loadConfig);
    assert.equal(library.locate, locate);
  });
});
