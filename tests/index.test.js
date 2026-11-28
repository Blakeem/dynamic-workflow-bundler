import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as library from 'dynamic-workflow-bundler';
import { build } from '../src/build.js';
import { cover } from '../src/cover.js';
import { inspect } from '../src/inspect.js';
import { loadConfig } from '../src/load-config.js';
import { locate } from '../src/locate.js';
import { map } from '../src/map.js';
import { simulate } from '../src/simulate.js';
import { snapshot } from '../src/snapshot.js';
import { validate } from '../src/validate.js';

describe('package entry', () => {
  it('exports build, cover, inspect, loadConfig, locate, map, simulate, snapshot and validate and nothing else', () => {
    assert.deepEqual(Object.keys(library), ['build', 'cover', 'inspect', 'loadConfig', 'locate', 'map', 'simulate', 'snapshot', 'validate']);
    assert.equal(library.build, build);
    assert.equal(library.cover, cover);
    assert.equal(library.inspect, inspect);
    assert.equal(library.loadConfig, loadConfig);
    assert.equal(library.locate, locate);
    assert.equal(library.map, map);
    assert.equal(library.simulate, simulate);
    assert.equal(library.snapshot, snapshot);
    assert.equal(library.validate, validate);
  });
});
