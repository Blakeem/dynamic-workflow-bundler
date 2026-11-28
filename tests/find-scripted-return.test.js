import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileSchema } from '../src/compile-schema.js';
import { findDecidingKey, findScriptedReturn } from '../src/find-scripted-return.js';

const OBJECT_SCHEMA = compileSchema({ type: 'object' });
const VERDICT_SCHEMA = compileSchema({ type: 'object', properties: { verdict: { enum: ['pass', 'fail'] }, notes: { type: 'array', items: { type: 'string' } } }, required: ['verdict'] });

/**
 * @param {number} index
 * @param {string | null} label
 * @returns {import('../src/find-scripted-return.js').PendingCall}
 */
function createCall(index, label) {
  return { index, label, prompt: `Prompt ${index}`, opts: label === null ? null : { label }, group: null };
}

/**
 * Answers each label in turn, as the simulation answers its calls in call order.
 * @param {import('../src/simulate.js').Respond} respond
 * @param {(string | null)[]} labels
 * @param {import('../src/compile-schema.js').CompiledSchema | null} [schema] The schema of each call.
 * @returns {import('../src/find-scripted-return.js').ScriptedReturnResult[]}
 */
function answerLabels(respond, labels, schema = null) {
  const earlierCalls = [];

  return labels.map((label, index) => {
    const call = createCall(index, label);
    const outcome = findScriptedReturn(respond, call, earlierCalls, schema);

    earlierCalls.push(outcome.kind === 'answered' ? { ...call, returned: outcome.returned } : call);
    return outcome;
  });
}

/**
 * @param {unknown} returned
 * @returns {import('../src/find-scripted-return.js').ScriptedReturnResult}
 */
const answered = (returned) => ({ kind: 'answered', returned });

describe('the key that decides a call', () => {
  it('is the longest key that the label starts with', () => {
    const keys = ['review', 'review final', ''];

    assert.equal(findDecidingKey(keys, 'review final 2'), 'review final');
    assert.equal(findDecidingKey(['review final', 'review'], 'review 1'), 'review');
    assert.equal(findDecidingKey(keys, 'draft'), '');
    assert.equal(findDecidingKey(['draft'], 'review'), null);
  });

  it("is the key '' for a call with no label, which no other key matches", () => {
    assert.equal(findDecidingKey(['review', ''], null), '');
    assert.equal(findDecidingKey(['review'], null), null);
  });
});

describe('a respond object', () => {
  it('answers each call with the value of the longest key that its label starts with', () => {
    const respond = { review: 'short', 'review final': 'long', '': 'any' };

    assert.deepEqual(answerLabels(respond, ['review final 2', 'review 1', null, 'draft']), [answered('long'), answered('short'), answered('any'), answered('any')]);
  });

  it('stops a call that no key matches, with a message that names its label and the key to add', () => {
    assert.deepEqual(answerLabels({ draft: 'd' }, ['review', null]), [
      { kind: 'stopped', reason: 'unanswered', message: "No key of respond matches call 0 (label \"review\"). Add a key that the label starts with, or the key ''" },
      { kind: 'stopped', reason: 'unanswered', message: "No key of respond matches call 1 (no label). Add the key '', which matches a call with no label" },
    ]);
    assert.equal(answerLabels(undefined, ['review'])[0].reason, 'unanswered');
    assert.match(answerLabels({}, ['line\nbreak'])[0].message, /label "line\\u\{000A\}break"/);
  });

  it('gives a list element by element to the calls its key decides, and none past its end', () => {
    const outcomes = answerLabels({ review: ['fail', 'pass'], draft: 'd' }, ['review', 'draft', 'review', 'review']);

    assert.deepEqual(outcomes.slice(0, 3), [answered('fail'), answered('d'), answered('pass')]);
    assert.deepEqual(outcomes[3], {
      kind: 'stopped',
      reason: 'unanswered',
      message: 'The list of key "review" holds 2 scripted returns, which earlier calls used up, so it has none for call 3 (label "review"). Add a scripted return to the list',
    });
  });

  it('stops a call whose key holds an empty list, with a message that says the list is empty', () => {
    assert.deepEqual(answerLabels({ review: [] }, ['review'])[0], {
      kind: 'stopped',
      reason: 'unanswered',
      message: 'The list of key "review" is empty, so it has none for call 0 (label "review"). Add a scripted return to the list',
    });
  });

  it('calls a function value with copies of the call and of the earlier calls, and gives what it returns', () => {
    const seen = [];
    const respond = {
      review: (call, earlierCalls) => {
        seen.push([call, earlierCalls.map((earlierCall) => earlierCall.returned)]);
        call.label = 'changed';
        return `return ${call.index}`;
      },
      draft: 'd',
    };
    const outcomes = answerLabels(respond, ['draft', 'review', 'review']);

    assert.deepEqual(outcomes, [answered('d'), answered('return 1'), answered('return 2')]);
    assert.deepEqual(seen.map(([call, returns]) => [call.index, call.prompt, returns]), [[1, 'Prompt 1', ['d']], [2, 'Prompt 2', ['d', 'return 1']]]);
  });

  it('stops a call whose key gives undefined, and names what it gives', () => {
    assert.deepEqual(answerLabels({ review: () => undefined }, ['review'])[0], {
      kind: 'stopped',
      reason: 'unanswered',
      message: 'The function of key "review" gives undefined to call 0 (label "review"). Give it a string or null',
    });
    assert.equal(answerLabels({ review: [undefined] }, ['review'])[0].reason, 'unanswered');
  });
});

describe('a respond function', () => {
  it('is called for every call, a call with no label included, and its throw reaches the caller', () => {
    const respond = (call) => `answer ${call.label}`;

    assert.deepEqual(answerLabels(respond, ['a', null]), [answered('answer a'), answered('answer null')]);
    assert.throws(() => answerLabels(() => {
      throw new Error('no answer');
    }, ['a']), /no answer/);
  });
});

describe('the type of a scripted return', () => {
  it('takes a string or null for a call with no schema, and a plain object or null for a call with one', () => {
    assert.deepEqual(answerLabels({ '': ['text', null] }, ['a', 'b']), [answered('text'), answered(null)]);
    assert.deepEqual(answerLabels({ '': [{ verdict: 'pass' }, null] }, ['a', 'b'], OBJECT_SCHEMA), [answered({ verdict: 'pass' }), answered(null)]);
  });

  it('stops a call with every other value', () => {
    const reasons = (values, schema) => answerLabels({ '': values }, values.map(() => 'call'), schema).map((outcome) => outcome.reason);

    assert.deepEqual(reasons([7, true, [[1]], { verdict: 'pass' }, () => 'x'], null), ['wrong-type', 'wrong-type', 'wrong-type', 'wrong-type', 'wrong-type']);
    assert.deepEqual(reasons([7, false, [[1]], 'pass', new Date(0)], OBJECT_SCHEMA), ['wrong-type', 'wrong-type', 'wrong-type', 'wrong-type', 'wrong-type']);
    assert.deepEqual(answerLabels({ review: 'pass' }, ['review'], OBJECT_SCHEMA)[0], {
      kind: 'stopped',
      reason: 'wrong-type',
      message: 'Key "review" of respond gives call 0 (label "review") a string, and a call with a schema takes a plain object or null. Give it a plain object or null',
    });
  });

  it('stops a call whose object holds a value JSON cannot carry, and names where it sits', () => {
    const cyclic = { verdict: 'pass' };
    cyclic.self = cyclic;
    const values = [{ run: () => 1 }, { missing: undefined }, { count: 1n }, { id: Symbol('id') }, cyclic, { seen: new Map() }, { score: Number.NaN }];
    const outcomes = answerLabels({ '': values }, values.map(() => 'call'), OBJECT_SCHEMA);

    assert.deepEqual(outcomes.map((outcome) => outcome.reason), values.map(() => 'not-json'));
    assert.equal(outcomes[4].message, 'Element 4 of the list of key "" gives call 4 (label "call") an object that holds a cycle at self, which JSON cannot carry. Give it JSON values only');
  });

  it('gives a JSON copy of the scripted return, so a later change to the scenario changes no scripted return', () => {
    const scripted = { items: ['kept'] };
    const [outcome] = answerLabels({ '': scripted }, ['a'], OBJECT_SCHEMA);

    scripted.items.push('changed');
    assert.deepEqual(outcome, answered({ items: ['kept'] }));
  });
});

describe('a scripted return against the schema of its call', () => {
  const breaksSchema = (message) => ({ kind: 'stopped', reason: 'breaks-schema', message });

  it('stops a call whose object breaks the schema, and names the giver, the place and the rule', () => {
    const respond = { review: { verdict: 'maybe' }, notes: [{ verdict: 'pass', notes: ['a', 2] }], '': () => ({}) };

    assert.deepEqual(answerLabels(respond, ['review', 'notes', null], VERDICT_SCHEMA), [
      breaksSchema('Key "review" of respond gives call 0 (label "review") an object that breaks the schema of the call at /verdict: must be equal to one of the allowed values. Give it an object that passes the schema'),
      breaksSchema('Element 0 of the list of key "notes" gives call 1 (label "notes") an object that breaks the schema of the call at /notes/1: must be string. Give it an object that passes the schema'),
      breaksSchema("The function of key \"\" gives call 2 (no label) an object that breaks the schema of the call at root: must have required property 'verdict'. Give it an object that passes the schema"),
    ]);
    assert.deepEqual(answerLabels(() => ({ verdict: 1 }), ['review'], VERDICT_SCHEMA)[0], breaksSchema('The respond function gives call 0 (label "review") an object that breaks the schema of the call at /verdict: must be equal to one of the allowed values. Give it an object that passes the schema'));
  });

  it('names the key that additionalProperties false forbids', () => {
    const closed = compileSchema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false });

    assert.equal(answerLabels({ '': { a: 'x', extra: 1 } }, ['a'], closed)[0].message, 'Key "" of respond gives call 0 (label "a") an object that breaks the schema of the call at root: must NOT have additional properties (\'extra\' is not allowed). Give it an object that passes the schema');
  });

  it('takes null, which stands for an agent that died, for a call whose schema requires a key', () => {
    assert.deepEqual(answerLabels({ '': null }, ['a'], VERDICT_SCHEMA), [answered(null)]);
  });

  it('gives an object that passes the schema, and a key the schema does not list passes', () => {
    assert.deepEqual(answerLabels({ '': { verdict: 'pass', extra: 1 } }, ['a'], VERDICT_SCHEMA), [answered({ verdict: 'pass', extra: 1 })]);
  });

  it('checks no string for a call with no schema', () => {
    assert.deepEqual(answerLabels({ '': 'any text' }, ['a']), [answered('any text')]);
  });
});
