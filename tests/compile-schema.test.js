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
    assert.equal(typeof compiled.findProblem, 'function');
  });

  it("refuses a schema that breaks the meta-schema, with the validator's text after its leading words", () => {
    assert.deepEqual(compileSchema({ type: 'object', required: 'a' }), { refusal: 'data/required must be array', findProblem: null });
  });

  it("refuses a schema with an unknown keyword, with the validator's entire text", () => {
    assert.deepEqual(compileSchema({ type: 'object', fooBar: 1 }), { refusal: 'strict mode: unknown keyword: "fooBar"', findProblem: null });
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
