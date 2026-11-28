import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { simulate } from 'dynamic-workflow-bundler';
import { compileSchema } from '../src/compile-schema.js';
import { createReturn } from '../src/create-return.js';
import { loadScenarios } from '../src/load-scenarios.js';
import { findSimulateFixture } from './support/find-simulate-fixture.js';

const schemaProbe = JSON.parse(await readFile(new URL('./fixtures/runtime/schema-probe.measured.json', import.meta.url), 'utf8'));
const MINIMAL_RETURN_SCENARIOS = fileURLToPath(new URL('./fixtures/simulate/minimal-return.scenarios.js', import.meta.url));
const PATTERN_SCHEMA = { type: 'object', properties: { code: { type: 'string', pattern: '^[A-Z]{3}$' } }, required: ['code'] };

/**
 * @param {Record<string, unknown>} keySchema
 * @returns {unknown} The value createReturn() makes for the required key `k` under that schema.
 */
function makeKeyValue(keySchema) {
  return createReturn({ type: 'object', properties: { k: keySchema }, required: ['k'] }).k;
}

/**
 * @param {unknown} schema
 * @param {unknown} values
 * @param {string | RegExp} message
 */
function assertUsageError(schema, values, message) {
  assert.throws(() => createReturn(schema, values), { name: 'UsageError', message });
}

describe('createReturn smallest values', () => {
  it('gives the value of a const and the first value of an enum', () => {
    assert.deepEqual(makeKeyValue({ const: { a: [1] } }), { a: [1] });
    assert.equal(makeKeyValue({ type: 'string', enum: ['pass', 'fail'] }), 'pass');
  });

  it('gives the smallest value of the schema a $ref names, # and an escaped pointer included', () => {
    const schema = {
      type: 'object',
      $defs: { 'a/b~c d': { type: 'string', minLength: 2 } },
      properties: { named: { $ref: '#/$defs/a~1b~0c%20d' }, root: { anyOf: [{ $ref: '#' }, { type: 'null' }] } },
      required: ['named', 'root'],
    };

    assert.deepEqual(createReturn(schema), { named: 'xx', root: null });
  });

  it('gives null for a $ref to a schema whose smallest value is still being made', () => {
    const schema = { type: 'object', $defs: { node: { type: 'object', properties: { next: { anyOf: [{ $ref: '#/$defs/node' }, { type: 'null' }] } }, required: ['next'] } }, properties: { node: { $ref: '#/$defs/node' } }, required: ['node'] };

    assert.deepEqual(createReturn(schema), { node: { next: null } });
  });

  it('keeps a schema still being made after values give an object under a $ref back to it', () => {
    const self = { anyOf: [{ $ref: '#' }, { type: 'null' }] };
    const schema = { type: 'object', properties: { a: self, b: self }, required: ['a', 'b'] };

    assert.deepEqual(createReturn(schema, { a: {} }), { a: { a: null, b: null }, b: null });
  });

  it('reads a $ref of #/ as the root, as the validator does', () => {
    const schema = { type: 'object', properties: { a: { anyOf: [{ $ref: '#/' }, { type: 'null' }] }, b: { type: 'string' } }, required: ['b'] };

    assert.deepEqual(createReturn(schema, { a: {} }), { b: '', a: { b: '' } });
  });

  it('gives the smallest value of the first schema of an anyOf and of a oneOf', () => {
    assert.equal(makeKeyValue({ anyOf: [{ type: 'integer' }, { type: 'string' }] }), 0);
    assert.equal(makeKeyValue({ oneOf: [{ type: 'boolean' }, { type: 'string' }] }), false);
  });

  it('follows the first oneOf schema before the own type', () => {
    assert.equal(makeKeyValue({ type: 'string', oneOf: [{ const: 'approve' }, { const: 'reject' }] }), 'approve');
  });

  it('reads the first type of a type list', () => {
    assert.equal(makeKeyValue({ type: ['string', 'null'] }), '');
  });

  it('gives an object each required key, with null for a key that properties lacks', () => {
    assert.deepEqual(makeKeyValue({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'zz'] }), { a: '', zz: null });
    assert.deepEqual(createReturn({ type: 'object', required: ['constructor', '__proto__'] }), JSON.parse('{"constructor":null,"__proto__":null}'));
  });

  it('gives an array minItems copies of the smallest value of items, or no element', () => {
    const list = makeKeyValue({ type: 'array', items: { type: 'object', properties: { s: { type: 'string' } }, required: ['s'] }, minItems: 2 });

    assert.deepEqual(list, [{ s: '' }, { s: '' }]);
    assert.notEqual(list[0], list[1]);
    assert.deepEqual(makeKeyValue({ type: 'array', items: { type: 'string' } }), []);
  });

  it('gives a string minLength times the letter x, or the empty string', () => {
    assert.equal(makeKeyValue({ type: 'string', minLength: 3 }), 'xxx');
    assert.equal(makeKeyValue({ type: 'string' }), '');
  });

  it('gives a number 0, raised to a minimum above 0 and past an exclusiveMinimum of 0 or more', () => {
    assert.equal(makeKeyValue({ type: 'number' }), 0);
    assert.equal(makeKeyValue({ type: 'number', minimum: 2.5 }), 2.5);
    assert.equal(makeKeyValue({ type: 'integer', minimum: 2.5 }), 3);
    assert.equal(makeKeyValue({ type: 'integer', minimum: -4 }), 0);
    assert.equal(makeKeyValue({ type: 'integer', exclusiveMinimum: 0 }), 1);
    assert.equal(makeKeyValue({ type: 'number', exclusiveMinimum: 2.5 }), 3);
    assert.equal(makeKeyValue({ type: 'integer', exclusiveMinimum: -3 }), 0);
    assert.equal(makeKeyValue({ type: 'integer', minimum: 5, exclusiveMinimum: 7 }), 8);
  });

  it('gives a boolean false, null null and a schema with no rule null', () => {
    assert.equal(makeKeyValue({ type: 'boolean' }), false);
    assert.equal(makeKeyValue({ type: 'null' }), null);
    assert.equal(makeKeyValue({}), null);
    assert.equal(makeKeyValue(true), null);
  });

  it('fills the required keys of a nested object', () => {
    const schema = { type: 'object', properties: { outer: { type: 'object', properties: { inner: { type: 'boolean' } }, required: ['inner'] } }, required: ['outer'] };

    assert.deepEqual(createReturn(schema), { outer: { inner: false } });
  });

  it('fills the required keys of the root that holds a oneOf beside them', () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' } }, required: ['verdict'], oneOf: [{ required: ['a'] }, { required: ['b'] }] };

    assert.deepEqual(createReturn(schema, { a: 'x' }), { verdict: '', a: 'x' });
  });
});

describe('createReturn values', () => {
  const schema = {
    type: 'object',
    $defs: { finding: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer', minimum: 1 } }, required: ['file', 'line'] } },
    properties: { verdict: { type: 'string' }, note: { type: 'string' }, first: { $ref: '#/$defs/finding' }, findings: { type: 'array', items: { $ref: '#/$defs/finding' } } },
    required: ['verdict', 'first', 'findings'],
  };

  it('puts each key of values in place of the key it names, and fills a nested object it gives', () => {
    const result = createReturn(schema, { verdict: 'fail', note: 'n', first: { file: 'a.js' } });

    assert.deepEqual(result, { verdict: 'fail', first: { file: 'a.js', line: 1 }, findings: [], note: 'n' });
  });

  it('keeps a list as given', () => {
    const findings = [{ file: 'a.js', line: 2 }];

    assert.deepEqual(createReturn(schema, { findings }).findings, findings);
    assert.throws(() => createReturn(schema, { findings: [{ file: 'a.js' }] }), { name: 'UsageError', message: "createReturn() cannot make an object that passes the schema at /findings/0: must have required property 'line'. Change that value in values" });
  });

  it('keeps an object as given under a key whose schema has a const or an enum', () => {
    const keySchema = { type: 'object', properties: { a: { anyOf: [{ type: 'object', required: ['x'] }, { type: 'object' }] } } };
    const enumSchema = { type: 'object', properties: { k: { ...keySchema, enum: [{ a: {} }] } }, required: ['k'] };
    const constSchema = { type: 'object', properties: { k: { ...keySchema, const: { a: {} } } }, required: ['k'] };

    assert.deepEqual(createReturn(enumSchema, { k: { a: {} } }), { k: { a: {} } });
    assert.deepEqual(createReturn(constSchema, { k: { a: {} } }), { k: { a: {} } });
  });

  it('returns a new object each call, which shares no reference with values or the schema', () => {
    const constSchema = { type: 'object', properties: { fixed: { const: { list: [] } } }, required: ['fixed', 'findings'] };
    const values = { findings: [{ file: 'a.js' }] };
    const first = createReturn(constSchema, values);
    const second = createReturn(constSchema, values);

    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.fixed, second.fixed);
    assert.notEqual(first.fixed, constSchema.properties.fixed.const);
    assert.notEqual(first.findings, values.findings);
    assert.notEqual(first.findings[0], second.findings[0]);
  });
});

describe('createReturn errors', () => {
  it('throws a UsageError for a schema that is no plain object of JSON values', () => {
    assertUsageError(null, {}, 'createReturn() takes schema as a plain object');
    assertUsageError([], {}, 'createReturn() takes schema as a plain object');
    assertUsageError(new Map(), {}, 'createReturn() takes schema as a plain object');
    assertUsageError({ type: 'object', properties: { a: { type: 'string', minLength: 1n } } }, {}, 'createReturn() takes schema as a plain object of JSON values, and it holds a BigInt at properties.a.minLength, which JSON cannot carry');
  });

  it('throws a UsageError with the refusal for a schema that agent() refuses', () => {
    assertUsageError({ type: 'object', required: 'a' }, {}, 'createReturn() takes a schema that agent() takes, and agent() refuses this one: data/required must be array');
  });

  it("throws a UsageError for a schema whose type is not 'object'", () => {
    assertUsageError({ type: 'array' }, {}, "createReturn() takes a schema whose type is 'object', as agent() does");
    assertUsageError({ type: ['object', 'null'] }, {}, "createReturn() takes a schema whose type is 'object', as agent() does");
  });

  it('throws a UsageError for values that is no plain object of JSON values', () => {
    assertUsageError({ type: 'object' }, null, 'createReturn() takes values as a plain object');
    assertUsageError({ type: 'object' }, ['a'], 'createReturn() takes values as a plain object');
    assertUsageError({ type: 'object' }, { list: [() => 1] }, 'createReturn() takes values as a plain object of JSON values, and it holds a function at list[0], which JSON cannot carry');
    assertUsageError({ type: 'object' }, { at: new Date(0) }, 'createReturn() takes values as a plain object of JSON values, and it holds a Date at at, which JSON cannot carry');
  });

  it('names the place of a keyword the rules do not read, and gives the object once values holds that key', () => {
    assertUsageError(PATTERN_SCHEMA, {}, 'createReturn() cannot make an object that passes the schema at /code: must match pattern "^[A-Z]{3}$". Give that value in values');
    assert.deepEqual(createReturn(PATTERN_SCHEMA, { code: 'ABC' }), { code: 'ABC' });
  });

  it('names a change to a value that values gives, an escaped key included', () => {
    const schema = { type: 'object', properties: { 'a/b': { type: 'integer' } }, required: ['a/b'] };

    assertUsageError(schema, { 'a/b': 'x' }, 'createReturn() cannot make an object that passes the schema at /a~1b: must be integer. Change that value in values');
  });

  it('names a change to the keys of values for a problem at the root', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };

    assertUsageError(schema, { b: 1 }, "createReturn() cannot make an object that passes the schema at root: must NOT have additional properties ('b' is not allowed). Change the keys of values");
  });

  it('throws a UsageError for a check of the object that runs out of stack', () => {
    assertUsageError({ type: 'object', anyOf: [{ $ref: '#' }] }, {}, 'createReturn() cannot check its object, since the check of it against the schema runs out of stack, as for a schema whose $ref leads back to itself with no key between or an object nested too deep. Change the schema or nest values less deep');
  });
});

describe(`createReturn of each schema that Claude Code ${schemaProbe.measuredOn} started with`, () => {
  for (const { key, schema } of schemaProbe.schemas.filter((probeCase) => probeCase.outcome.started === 'with the schema')) {
    it(`gives an object that passes the schema "${key}"`, () => {
      assert.equal(compileSchema(schema).findProblem(createReturn(schema)), null);
    });
  }
});

describe('createReturn in a scenarios file', () => {
  it('gives a respond function a return that passes the schema of its call through simulate()', async () => {
    const [{ scenario }] = await loadScenarios(MINIMAL_RETURN_SCENARIOS);
    const trace = await simulate({ script: findSimulateFixture('minimal-return'), scenario });

    assert.deepEqual(trace.end, { kind: 'returned', value: { status: 'passed', review: { verdict: 'pass', findings: [], score: 1 } } });
  });
});
