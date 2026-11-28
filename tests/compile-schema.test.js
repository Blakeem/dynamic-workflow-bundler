import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { compileSchema } from '../src/compile-schema.js';

const CHILD_TIME_LIMIT_MS = 30000;
// On Node.js 24.22.1 the validator ran out of stack at 300 levels, and JSON.stringify kept going past 2,000.
const DEEP_SCHEMA_DEPTH = 1000;

describe('compileSchema', () => {
  it('takes a schema the runtime takes, with no refusal', () => {
    const compiled = compileSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });

    assert.equal(compiled.refusal, null);
    assert.equal(compiled.findProblem({ a: 'x' }), null);
  });

  it("refuses a schema that breaks the meta-schema, with the validator's text after its leading words", () => {
    assert.deepEqual(compileSchema({ type: 'object', required: 'a' }), { refusal: 'data/required must be array', findProblem: null });
  });

  it("refuses a schema with an unknown keyword, with the validator's entire text", () => {
    assert.deepEqual(compileSchema({ type: 'object', fooBar: 1 }), { refusal: 'strict mode: unknown keyword: "fooBar"', findProblem: null });
  });

  it('finds no problem in a value that passes the schema, and else the path and the message of its first error', () => {
    const { findProblem } = compileSchema({ type: 'object', properties: { o: { type: 'object', properties: { k: { type: 'string' } } } }, required: ['o'] });

    assert.equal(findProblem({ o: { k: 'x' }, extra: 1 }), null);
    assert.deepEqual(findProblem({}), { path: 'root', message: "must have required property 'o'" });
    assert.deepEqual(findProblem({ o: { k: 1 } }), { path: '/o/k', message: 'must be string' });
  });

  it('names the key that additionalProperties false forbids, as the runtime does', () => {
    const { findProblem } = compileSchema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false });

    assert.deepEqual(findProblem({ a: 'x', extra: 1 }), { path: 'root', message: "must NOT have additional properties ('extra' is not allowed)" });
  });

  it('rejects an unlisted key whose value breaks the schema of additionalProperties', () => {
    const { findProblem } = compileSchema({ type: 'object', properties: { a: { type: 'object', additionalProperties: { type: 'string' } } } });

    assert.equal(findProblem({ a: { z: 'x' } }), null);
    assert.deepEqual(findProblem({ a: { z: 1 } }), { path: '/a/z', message: 'must be string' });
  });

  for (const asyncValue of [true, 1, 'yes']) {
    it(`takes a schema with $async ${JSON.stringify(asyncValue)} and finds no problem in a value that breaks it`, () => {
      const compiled = compileSchema({ type: 'object', $async: asyncValue, required: ['a'] });

      assert.equal(compiled.refusal, null);
      assert.equal(compiled.findProblem({ b: 1 }), null);
    });
  }

  it('checks a value under a schema with $async false', () => {
    const { findProblem } = compileSchema({ type: 'object', $async: false, required: ['a'] });

    assert.deepEqual(findProblem({ b: 1 }), { path: 'root', message: "must have required property 'a'" });
  });

  it('takes two schemas with one $id, compiled one after the other', () => {
    const schema = { type: 'object', $id: 'https://example.com/one.schema.json' };

    assert.equal(compileSchema(schema).refusal, null);
    assert.equal(compileSchema({ ...schema, properties: { a: { type: 'string' } } }).refusal, null);
  });

  it('throws the RangeError of a compile that runs out of stack instead of a refusal', () => {
    let schema = { type: 'object' };

    for (let depth = 0; depth < DEEP_SCHEMA_DEPTH; depth += 1) schema = { type: 'object', properties: { a: schema } };
    assert.throws(() => compileSchema(schema), RangeError);
  });

  it('prints nothing for a schema that the validator warns about', () => {
    const moduleUrl = new URL('../src/compile-schema.js', import.meta.url).href;
    const code = `import { compileSchema } from ${JSON.stringify(moduleUrl)};\ncompileSchema({ type: 'object', properties: { n: { minimum: 1 } } });`;
    const { status, stdout, stderr } = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: CHILD_TIME_LIMIT_MS });

    assert.deepEqual({ status, stdout, stderr }, { status: 0, stdout: '', stderr: '' });
  });
});
