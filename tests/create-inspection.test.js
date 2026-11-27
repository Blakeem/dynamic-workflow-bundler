import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createInspection } from '../src/create-inspection.js';
import { UsageError } from '../src/usage-error.js';

const HEAD = { script: 'flow.js', scenario: 'stops at the last call', runtime: '2.1.332' };
const STOP_MESSAGE = 'No key of respond matches call 3 (no label)';
const PLAN_OPTS = { label: 'plan' };
const VERDICT = { verdict: 'pass' };
const PARALLEL_GROUP = { index: 0, kind: 'parallel', item: 1, items: 2, stage: 0, stages: 1 };
const PIPELINE_GROUP = { index: 1, kind: 'pipeline', item: 0, items: 1, stage: 1, stages: 2 };

/**
 * A trace whose call index differs from its group index at each call in a group, and whose last call is the
 * call the simulation stopped at.
 * @returns {import('../src/simulate.js').Trace}
 */
function createStoppedTrace() {
  return {
    ...HEAD,
    end: { kind: 'stopped', reason: 'unanswered', message: STOP_MESSAGE, call: 3 },
    calls: [
      { index: 0, label: 'plan', prompt: 'Plan it', opts: PLAN_OPTS, group: null, phase: 'Plan', returned: 'the plan' },
      { index: 1, label: 'fan a', prompt: 'Review part a', opts: { label: 'fan a' }, group: { group: 0, item: 0, stage: 0 }, phase: 'Fan', returned: VERDICT },
      { index: 2, label: 'fan b', prompt: 'Review part b', opts: { label: 'fan b' }, group: { group: 0, item: 1, stage: 0 }, phase: 'Fan', returned: null },
      { index: 3, label: null, prompt: 'Merge', opts: null, group: { group: 1, item: 0, stage: 1 }, phase: null },
    ],
    groups: [
      { kind: 'parallel', items: 2, stages: 1 },
      { kind: 'pipeline', items: 1, stages: 2 },
    ],
    phases: [
      { title: 'Plan', beforeCall: 0 },
      { title: 'Fan', beforeCall: 1 },
    ],
    logs: ['planned'],
    events: [
      { kind: 'phase', index: 0 },
      { kind: 'call', index: 0 },
      { kind: 'log', index: 0 },
      { kind: 'phase', index: 1 },
      { kind: 'call', index: 1 },
      { kind: 'call', index: 2 },
      { kind: 'call', index: 3 },
    ],
  };
}

/**
 * @param {number} callCount
 * @returns {import('../src/simulate.js').Trace} A trace that returned after `callCount` calls with no group
 *   and no phase.
 */
function createReturnedTrace(callCount) {
  const calls = Array.from({ length: callCount }, (_, index) => ({ index, label: null, prompt: 'p', opts: null, group: null, phase: null, returned: 'r' }));

  return { ...HEAD, end: { kind: 'returned', value: null }, calls, groups: [], phases: [], logs: [], events: calls.map((call) => ({ kind: 'call', index: call.index })) };
}

/**
 * @param {import('../src/simulate.js').Trace} trace
 * @param {unknown} call
 * @returns {import('../src/create-inspection.js').Inspection} The inspection, after checking that JSON keeps it.
 */
function inspectTrace(trace, call = undefined) {
  const inspection = createInspection(trace, call);

  assert.deepEqual(JSON.parse(JSON.stringify(inspection)), inspection);
  return inspection;
}

describe('createInspection with no call', () => {
  it('gives the head of the trace, its call count and one event per event of the trace, in order', () => {
    const trace = createStoppedTrace();
    const inspection = inspectTrace(trace);

    assert.deepEqual(Object.keys(inspection), ['script', 'scenario', 'runtime', 'end', 'callCount', 'events']);
    assert.deepEqual(inspection, {
      ...HEAD,
      end: trace.end,
      callCount: 4,
      events: [
        { kind: 'phase', title: 'Plan' },
        { kind: 'call', index: 0, label: 'plan', phase: 'Plan', group: null, promptLength: 7, returnedType: 'string', returnedLength: 8 },
        { kind: 'log', text: 'planned' },
        { kind: 'phase', title: 'Fan' },
        { kind: 'call', index: 1, label: 'fan a', phase: 'Fan', group: { ...PARALLEL_GROUP, item: 0 }, promptLength: 13, returnedType: 'object', returnedLength: null },
        { kind: 'call', index: 2, label: 'fan b', phase: 'Fan', group: PARALLEL_GROUP, promptLength: 13, returnedType: 'null', returnedLength: null },
        { kind: 'call', index: 3, label: null, phase: null, group: PIPELINE_GROUP, promptLength: 5, returnedType: 'none', returnedLength: null },
      ],
    });
  });

  it('orders the keys of a call event and of its group as the inspection names them', () => {
    const callEvent = inspectTrace(createStoppedTrace()).events.at(-1);

    assert.deepEqual(Object.keys(callEvent), ['kind', 'index', 'label', 'phase', 'group', 'promptLength', 'returnedType', 'returnedLength']);
    assert.deepEqual(Object.keys(callEvent.group), ['index', 'kind', 'item', 'items', 'stage', 'stages']);
  });

  it('gives a refused trace no event and a call count of 0', () => {
    const end = { kind: 'refused', findings: [{ rule: 'meta-not-first', message: 'The first statement is not export const meta', fix: 'Make export const meta = { ... } the first statement', file: 'flow.js', line: 1, column: 1 }] };
    const trace = { ...HEAD, end, calls: [], groups: [], phases: [], logs: [], events: [] };

    assert.deepEqual(inspectTrace(trace), { ...HEAD, end, callCount: 0, events: [] });
  });
});

describe('createInspection with a call', () => {
  it('gives a call with a scripted return in full, with the group of its group index', () => {
    const trace = createStoppedTrace();
    const inspection = inspectTrace(trace, 2);

    assert.deepEqual(Object.keys(inspection), ['script', 'scenario', 'runtime', 'end', 'callCount', 'call']);
    assert.deepEqual(inspection, {
      ...HEAD,
      end: trace.end,
      callCount: 4,
      call: { index: 2, label: 'fan b', phase: 'Fan', group: PARALLEL_GROUP, opts: { label: 'fan b' }, prompt: 'Review part b', returned: null },
    });
    assert.deepEqual(Object.keys(inspection.call), ['index', 'label', 'phase', 'group', 'opts', 'prompt', 'returned']);
  });

  it('gives a call with no group and its string return', () => {
    assert.deepEqual(inspectTrace(createStoppedTrace(), 0).call, { index: 0, label: 'plan', phase: 'Plan', group: null, opts: PLAN_OPTS, prompt: 'Plan it', returned: 'the plan' });
  });

  it('gives the call the simulation stopped at with no returned key, in a later pipeline() stage', () => {
    const { call } = inspectTrace(createStoppedTrace(), 3);

    assert.deepEqual(call, { index: 3, label: null, phase: null, group: PIPELINE_GROUP, opts: null, prompt: 'Merge' });
    assert.equal(Object.hasOwn(call, 'returned'), false);
  });

  it('rejects a call that is not the index of a call, naming the calls the simulation made', () => {
    const severalCalls = 'The simulation made 4 calls, so name a call from 0 to 3';

    for (const call of [-1, 4, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => createInspection(createStoppedTrace(), call), (error) => error instanceof UsageError && error.message === severalCalls, String(call));
    }
    assert.throws(() => createInspection(createReturnedTrace(1), 1), { name: 'UsageError', message: 'The simulation made 1 call, so the one call is 0' });
    assert.throws(() => createInspection(createReturnedTrace(0), 0), { name: 'UsageError', message: 'The simulation made no call' });
  });

  it('gives the one call of a trace with one call', () => {
    assert.equal(inspectTrace(createReturnedTrace(1), 0).call.index, 0);
  });
});
