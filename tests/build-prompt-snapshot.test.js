import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { buildPromptSnapshot } from '../src/build-prompt-snapshot.js';
import { formatSimulationEnd } from '../src/format-simulation-end.js';

const RETURNED = { kind: 'returned', value: null };
const PASS_SCHEMA = { type: 'object', properties: { pass: { type: 'boolean' } } };
const REASON_SCHEMA = { type: 'object', properties: { pass: { type: 'boolean' }, reason: { type: 'string' } } };

/**
 * @typedef {{ label: string | null, prompt: string, schema?: unknown, opts?: unknown }} CallSpec The call's options
 *   are `opts` when given, else its label and its schema.
 */

/**
 * @param {string} name
 * @param {CallSpec[]} callSpecs
 * @param {unknown} [end]
 * @returns {import('../src/build-prompt-snapshot.js').SnapshotSimulation}
 */
function createSimulation(name, callSpecs, end = RETURNED) {
  const calls = callSpecs.map(({ label, prompt, schema, opts }, index) => ({
    index,
    label,
    prompt,
    opts: opts !== undefined ? opts : { ...(label === null ? {} : { label }), ...(schema === undefined ? {} : { schema }) },
    group: null,
    phase: null,
  }));

  return { name, trace: /** @type {any} */ ({ end, calls }) };
}

/**
 * @param {import('../src/build-prompt-snapshot.js').SnapshotSimulation[]} runs
 * @param {string[]} [roles]
 * @param {Record<string, number> | null} [promptBudgets]
 * @returns {import('../src/build-prompt-snapshot.js').PromptSnapshot}
 */
function build(runs, roles = ['review', 'verify'], promptBudgets = null) {
  return buildPromptSnapshot({ roles, runs, promptBudgets });
}

/**
 * @param {import('../src/build-prompt-snapshot.js').PromptSnapshot} promptSnapshot
 * @returns {string[]} Each variant as `<role> <number> <schemaNumber> <label>`.
 */
function listVariantNames({ variants }) {
  return /** @type {any[]} */ (variants).map(({ role, number, schemaNumber, label }) => `${role} ${number} ${schemaNumber} ${label}`);
}

describe('buildPromptSnapshot', () => {
  it('keeps the first call of each variant, in scenario order and then call order, with the scenario that sent it', () => {
    const first = createSimulation('first', [
      { label: 'review:core', prompt: 'Review core in 3 steps.' },
      { label: 'verify r1', prompt: 'Verify round 1.', schema: PASS_SCHEMA },
    ]);
    const second = createSimulation('second', [
      { label: 'review:tools', prompt: 'Review tools in 4 steps.' },
      { label: 'verify r1', prompt: 'Verify round 1.', schema: PASS_SCHEMA },
      { label: 'verify r2', prompt: 'Verify round 2.\nRound 1 failed.', schema: PASS_SCHEMA },
    ]);
    const { variants } = build([first, second]);

    assert.deepEqual(variants, [
      { role: 'review', number: 1, schemaNumber: 1, characters: 23, scenario: 'first', label: 'review:core', prompt: 'Review core in 3 steps.', schema: null },
      { role: 'verify', number: 1, schemaNumber: 1, characters: 15, scenario: 'first', label: 'verify r1', prompt: 'Verify round 1.', schema: PASS_SCHEMA },
      { role: 'verify', number: 2, schemaNumber: 1, characters: 31, scenario: 'second', label: 'verify r2', prompt: 'Verify round 2.\nRound 1 failed.', schema: PASS_SCHEMA },
    ]);
  });

  it('gives a call with no label the role (no label), and a label that starts with no role its own role', () => {
    const result = build([
      createSimulation('a', [
        { label: null, prompt: 'Run.' },
        { label: 'note', prompt: 'Write a note.' },
        { label: 'review:core', prompt: 'Review.' },
        { label: null, prompt: 'Run.', opts: null },
      ]),
    ]);

    assert.deepEqual(listVariantNames(result), ['(no label) 1 1 null', 'note 1 1 note', 'review 1 1 review:core']);
    assert.deepEqual(result.roles.map(({ role }) => role), ['(no label)', 'note', 'review']);
  });

  it('gives a call with the empty label the role (no label), and keeps its empty label on its variant', () => {
    const result = build([
      createSimulation('a', [
        { label: null, prompt: 'Run.' },
        { label: '', prompt: 'Run the empty label.' },
      ]),
    ]);

    assert.deepEqual(listVariantNames(result), ['(no label) 1 1 null', '(no label) 2 1 ']);
    assert.equal(/** @type {any[]} */ (result.variants)[1].label, '');
    assert.deepEqual(result.roles, [{ role: '(no label)', characters: 20, promptBudget: null }]);
  });

  it('numbers each distinct schema of a role, and gives a call with no schema the schema null', () => {
    const result = build([
      createSimulation('a', [
        { label: 'verify r1', prompt: 'Verify.', schema: PASS_SCHEMA },
        { label: 'verify r2', prompt: 'Verify.', schema: REASON_SCHEMA },
        { label: 'verify r3', prompt: 'Verify.', schema: PASS_SCHEMA },
        { label: 'verify r4', prompt: 'Verify.' },
        { label: 'verify r5', prompt: 'Verify.', opts: 'not an object' },
      ]),
    ]);

    assert.deepEqual(listVariantNames(result), ['verify 1 1 verify r1', 'verify 2 2 verify r2', 'verify 3 3 verify r4']);
    assert.equal(/** @type {any[]} */ (result.variants)[2].schema, null);
  });

  it('masks a lowercase hex word of 8 characters or more, and no shorter or uppercase one', () => {
    const seven = build([createSimulation('a', [{ label: 'review', prompt: 'Id abcdef1.' }, { label: 'review', prompt: 'Id fedcba2.' }])]);
    const eight = build([createSimulation('a', [{ label: 'review', prompt: 'Id abcdef12.' }, { label: 'review', prompt: 'Id fedcba21.' }])]);
    const upper = build([createSimulation('a', [{ label: 'review', prompt: 'Id ABCDEF12.' }, { label: 'review', prompt: 'Id FEDCBA21.' }])]);

    assert.equal(seven.variants?.length, 2);
    assert.equal(eight.variants?.length, 1);
    assert.equal(upper.variants?.length, 2);
  });

  it('masks a hex id joined to a word by _, and a UUID of either case', () => {
    const joined = build([createSimulation('a', [{ label: 'review', prompt: 'Run run_4827a4b4.' }, { label: 'review', prompt: 'Run run_c0ffee5d.' }])]);
    const uuid = build([
      createSimulation('a', [
        { label: 'review', prompt: 'Id a6e0ab7d-0205-4118-ae78-7af7384555aa.' },
        { label: 'review', prompt: 'Id 1c2d3e4f-0000-4b3c-b3c1-0123456789ab.' },
      ]),
    ]);
    const upperUuid = build([
      createSimulation('a', [
        { label: 'review', prompt: 'Id A6E0AB7D-0205-4118-AE78-7AF7384555AA.' },
        { label: 'review', prompt: 'Id 1C2D3E4F-0000-4B3C-B3C1-0123456789AB.' },
        { label: 'review', prompt: 'Id 1c2d3e4f-0000-4b3c-b3c1-0123456789ab.' },
      ]),
    ]);
    const inWord = build([createSimulation('a', [{ label: 'review', prompt: 'Id xabcdef12.' }, { label: 'review', prompt: 'Id xfedcba21.' }])]);

    assert.equal(joined.variants?.length, 1);
    assert.equal(uuid.variants?.length, 1);
    assert.equal(upperUuid.variants?.length, 1);
    assert.equal(inWord.variants?.length, 2);
  });

  it('masks each run of digits', () => {
    const result = build([createSimulation('a', [{ label: 'verify r1', prompt: 'Check 3 of 12 units.' }, { label: 'verify r2', prompt: 'Check 4 of 120 units.' }])]);

    assert.equal(result.variants?.length, 1);
  });

  it('masks each run of decimal digits of any script, and keeps a number character that is no decimal digit', () => {
    const arabicIndic = build([createSimulation('a', [{ label: 'verify r1', prompt: 'Check round ١٢.' }, { label: 'verify r2', prompt: 'Check round ٣.' }])]);
    const fullwidth = build([createSimulation('a', [{ label: 'verify r1', prompt: 'Check round １２.' }, { label: 'verify r2', prompt: 'Check round ３.' }])]);
    const superscript = build([createSimulation('a', [{ label: 'verify r1', prompt: 'Check x².' }, { label: 'verify r2', prompt: 'Check x³.' }])]);

    assert.equal(arabicIndic.variants?.length, 1);
    assert.equal(fullwidth.variants?.length, 1);
    assert.equal(superscript.variants?.length, 2);
  });

  it('leaves an item that a decimal digit of any script touches unmasked, and masks one that a superscript two touches', () => {
    const touched = [
      { label: 'review:core', prompt: 'Review core١.' },
      { label: 'review:tools', prompt: 'Review tools١.' },
    ];
    const superscript = [
      { label: 'review:core', prompt: 'Review core².' },
      { label: 'review:tools', prompt: 'Review tools².' },
    ];

    assert.deepEqual(listVariantNames(build([createSimulation('a', touched)])), ['review 1 1 review:core', 'review 2 1 review:tools']);
    assert.deepEqual(listVariantNames(build([createSimulation('a', superscript)])), ['review 1 1 review:core']);
  });

  it('masks the item of a call only when its role is a role of the script', () => {
    const calls = [
      { label: 'review:core', prompt: 'Review the unit core.' },
      { label: 'review:tools', prompt: 'Review the unit tools.' },
    ];

    assert.deepEqual(listVariantNames(build([createSimulation('a', calls)])), ['review 1 1 review:core']);
    assert.deepEqual(listVariantNames(build([createSimulation('a', calls)], [])), ['review:core 1 1 review:core', 'review:tools 1 1 review:tools']);
  });

  it('masks the item only where no letter or digit touches it, before the number mask', () => {
    const numeric = [
      { label: 'review:1', prompt: 'Review unit 1 of 12.' },
      { label: 'review:2', prompt: 'Review unit 2 of 12.' },
    ];
    const inWord = [
      { label: 'review:core', prompt: 'Review core, then score it.' },
      { label: 'review:tools', prompt: 'Review tools, then score it.' },
      { label: 'review:a.b', prompt: 'Review a.b, not axb.' },
      { label: 'review:c.d', prompt: 'Review c.d, not axb.' },
    ];

    assert.deepEqual(listVariantNames(build([createSimulation('a', numeric)])), ['review 1 1 review:1']);
    assert.deepEqual(listVariantNames(build([createSimulation('a', inWord)])), ['review 1 1 review:core', 'review 2 1 review:a.b']);
  });

  it('leaves an item that is a number or a hex id to the number masks, so a number of the fixed text equal to it splits no variant', () => {
    const round = [
      { label: 'review:1 r1', prompt: 'Review issue 1 in round 1.' },
      { label: 'review:2 r1', prompt: 'Review issue 2 in round 1.' },
    ];
    const count = [
      { label: 'review:1', prompt: 'Review unit 1 of 2.' },
      { label: 'review:2', prompt: 'Review unit 2 of 2.' },
    ];
    const hex = [
      { label: 'review:c0ffee5d', prompt: 'Run c0ffee5d after 1c2d3e4f.' },
      { label: 'review:1c2d3e4f', prompt: 'Run 1c2d3e4f after 1c2d3e4f.' },
    ];

    assert.deepEqual(listVariantNames(build([createSimulation('a', round)])), ['review 1 1 review:1 r1']);
    assert.deepEqual(listVariantNames(build([createSimulation('a', count)])), ['review 1 1 review:1']);
    assert.deepEqual(listVariantNames(build([createSimulation('a', hex)])), ['review 1 1 review:c0ffee5d']);
  });

  it('gives each role the largest prompt of every call of the role, and its prompt budget', () => {
    const result = build(
      [createSimulation('a', [{ label: 'review:core', prompt: 'Review core.' }, { label: 'review:tools', prompt: 'Review tools.' }, { label: 'verify r1', prompt: 'Verify.' }])],
      ['review', 'verify'],
      { review: 20, verify: 10 },
    );

    assert.equal(result.variants?.length, 2);
    assert.deepEqual(result.roles, [
      { role: 'review', characters: 13, promptBudget: 20 },
      { role: 'verify', characters: 7, promptBudget: 10 },
    ]);
    assert.deepEqual(result.promptBudgetProblems, []);
  });

  it('lists a role over its prompt budget and a role with none in role order, then each unused prompt budget in key order', () => {
    const runs = [createSimulation('a', [{ label: 'review:core', prompt: 'Review core.' }, { label: 'note', prompt: 'Note.' }, { label: 'verify r1', prompt: 'Verify it.' }])];
    const result = build(runs, ['review', 'verify'], { summary: 5, verify: 9, review: 12, constructor: 3 });

    assert.deepEqual(result.promptBudgetProblems, [
      { role: 'note', kind: 'missing', characters: 5, promptBudget: null },
      { role: 'verify', kind: 'over', characters: 10, promptBudget: 9 },
      { role: 'summary', kind: 'unused', characters: null, promptBudget: 5 },
      { role: 'constructor', kind: 'unused', characters: null, promptBudget: 3 },
    ]);
    assert.deepEqual(build(runs).promptBudgetProblems, []);
    assert.equal(build(runs, ['review', 'verify'], {}).promptBudgetProblems.length, 3);
  });

  it('gives no prompt budget to a role named for a property that every object inherits', () => {
    const result = build([createSimulation('a', [{ label: 'constructor', prompt: 'Run.' }])], [], {});

    assert.deepEqual(result.roles, [{ role: 'constructor', characters: 4, promptBudget: null }]);
  });

  it('counts every call and hashes the label, the prompt and the schema of each call in order', () => {
    const runs = [
      createSimulation('a', [{ label: 'verify r1', prompt: 'Verify 1.', schema: PASS_SCHEMA }, { label: null, prompt: 'Run.' }]),
      createSimulation('b', [{ label: 'verify r1', prompt: 'Verify 1.', schema: PASS_SCHEMA }]),
    ];
    const lines = [['verify r1', 'Verify 1.', PASS_SCHEMA], [null, 'Run.', null], ['verify r1', 'Verify 1.', PASS_SCHEMA]].map((line) => `${JSON.stringify(line)}\n`);
    const result = build(runs);

    assert.equal(result.callCount, 3);
    assert.equal(result.digest, createHash('sha256').update(lines.join(''), 'utf8').digest('hex'));
    assert.notEqual(build([runs[1], runs[0]]).digest, result.digest);
    assert.equal(build([]).digest, createHash('sha256').digest('hex'));
  });

  it('reads a scenario whose script threw, and counts its calls', () => {
    const threw = createSimulation('a', [{ label: 'verify r1', prompt: 'Verify.' }], { kind: 'threw', name: 'Error', message: 'gone', frames: [] });

    assert.equal(build([threw]).callCount, 1);
    assert.deepEqual(build([threw]).unread, []);
  });

  it('lists each scenario whose simulation stopped or whose script was refused, and then holds no variant', () => {
    const stopped = createSimulation('stops', [{ label: 'verify r1', prompt: 'Verify.' }], { kind: 'stopped', reason: 'unanswered', message: 'no scripted return answers it', call: 0 });
    const refused = createSimulation('refused', [], { kind: 'refused', findings: [] });
    const read = createSimulation('reads', [{ label: 'verify r1', prompt: 'Verify.' }]);

    assert.deepEqual(build([read, stopped, refused], ['verify'], { verify: 1, other: 3 }), {
      variants: null,
      roles: [],
      callCount: 0,
      digest: null,
      promptBudgetProblems: [],
      unread: [
        { scenario: 'stops', reason: formatSimulationEnd(stopped.trace) },
        { scenario: 'refused', reason: 'refused' },
      ],
    });
    assert.match(formatSimulationEnd(stopped.trace), /^stopped at call 0 /);
  });
});
