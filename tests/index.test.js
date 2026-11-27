import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as library from 'dynamic-workflow-bundler';
import { build } from '../src/build.js';
import { inspect } from '../src/inspect.js';
import { loadConfig } from '../src/load-config.js';
import { locate } from '../src/locate.js';
import { map } from '../src/map.js';
import { simulate } from '../src/simulate.js';
import { validate } from '../src/validate.js';

describe('package entry', () => {
  it('exports build, inspect, loadConfig, locate, map, simulate and validate and nothing else', () => {
    assert.deepEqual(Object.keys(library), ['build', 'inspect', 'loadConfig', 'locate', 'map', 'simulate', 'validate']);
    assert.equal(library.build, build);
    assert.equal(library.inspect, inspect);
    assert.equal(library.loadConfig, loadConfig);
    assert.equal(library.locate, locate);
    assert.equal(library.map, map);
    assert.equal(library.simulate, simulate);
    assert.equal(library.validate, validate);
  });
});
