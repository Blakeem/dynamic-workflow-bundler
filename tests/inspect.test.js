import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect, simulate } from 'dynamic-workflow-bundler';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { isObject } from '../src/is-object.js';
import { formatRealDisplayPath } from '../src/real-path.js';
import { SCENARIOS } from './fixtures/simulate/scenarios.js';
import { findSimulateFixture } from './support/find-simulate-fixture.js';

const PLANS_GROUP = { index: 0, kind: 'parallel', items: 3, stage: 0, stages: 1 };

/**
 * @param {string} name
 * @returns {Promise<{ script: string, runtime: string }>} The script and runtime an inspection of the fixture
 *   names.
 */
async function createHead(name) {
  return { script: await formatRealDisplayPath(findSimulateFixture(name)), runtime: CONTRACT_RUNTIME_VERSION };
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<unknown>} What the promise rejected with.
 */
async function findRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('The promise did not reject');
}

describe('inspect', () => {
  it('gives the events of one simulation in order', async () => {
    const inspection = await inspect({ script: findSimulateFixture('parallel-plans'), scenario: SCENARIOS.plansAnswered });
    const createPlanEvent = (index, part) => ({
      kind: 'call',
      index,
      label: `plan ${part}`,
      phase: 'Plan',
      group: { ...PLANS_GROUP, item: index },
      promptLength: `Plan the ${part}`.length,
      returnedType: 'string',
      returnedLength: `plan for plan ${part}`.length,
    });

    assert.deepEqual(inspection, {
      ...(await createHead('parallel-plans')),
      scenario: 'every plan answered',
      end: { kind: 'returned', value: ['plan for plan parser', 'plan for plan loader', 'plan for plan writer'] },
      callCount: 3,
      events: [
        { kind: 'phase', title: 'Plan' },
        createPlanEvent(0, 'parser'),
        createPlanEvent(1, 'loader'),
        createPlanEvent(2, 'writer'),
        { kind: 'log', text: 'plans: 3' },
      ],
    });
  });

  it('gives one call in full', async () => {
    const inspection = await inspect({ script: findSimulateFixture('review-loop'), scenario: SCENARIOS.reviewFailThenPass, call: 2 });
    const opts = { label: 'review', schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } };

    assert.deepEqual(inspection, {
      ...(await createHead('review-loop')),
      scenario: 'fail then pass',
      end: { kind: 'returned', value: { status: 'passed', round: 2 } },
      callCount: 3,
      call: { index: 2, label: 'review', phase: null, group: null, opts, prompt: 'Review round 2: the draft', returned: { verdict: 'pass' } },
    });
  });

  it('gives the events of a simulation when call is undefined', async () => {
    const inspection = await inspect({ script: findSimulateFixture('review-loop'), scenario: SCENARIOS.reviewFailThenPass, call: undefined });

    assert.deepEqual(inspection.events.map((event) => event.label), ['draft', 'review', 'review']);
  });

  it('gives a refused script no event, and rejects every call of it', async () => {
    const script = findSimulateFixture('no-meta');
    const inspection = await inspect({ script });

    assert.deepEqual([inspection.end.kind, inspection.callCount, inspection.events], ['refused', 0, []]);
    await assert.rejects(inspect({ script, call: 0 }), { name: 'UsageError', message: 'The simulation made no call' });
  });

  it('rejects a call the simulation did not make', async () => {
    await assert.rejects(inspect({ script: findSimulateFixture('review-loop'), scenario: SCENARIOS.reviewFailThenPass, call: 3 }), {
      name: 'UsageError',
      message: 'The simulation made 3 calls, so name a call from 0 to 2',
    });
  });

  it('rejects each options value that simulate() rejects with the same error, with or without call', async () => {
    const script = findSimulateFixture('review-loop');
    const rejectedOptions = [null, [script], script, {}, { script: '' }, { script, scenario: 5 }, { script, scenario: { names: [] } }, { script, scenario: SCENARIOS.respondThrows }];

    for (const options of rejectedOptions) {
      const simulateError = await findRejection(simulate(options));

      assert.equal(simulateError.name, 'UsageError', JSON.stringify(options));
      assert.deepEqual(await findRejection(inspect(options)), simulateError);
      if (isObject(options)) assert.deepEqual(await findRejection(inspect({ ...options, call: 0 })), simulateError);
    }
  });

  it('rejects an unknown key, naming inspect()', async () => {
    await assert.rejects(inspect({ script: findSimulateFixture('review-loop'), calls: 1 }), { name: 'UsageError', message: 'inspect() takes no option calls' });
  });

  it('reads an inherited script, scenario and call, as simulate() reads its options', async () => {
    const options = { script: findSimulateFixture('review-loop'), scenario: SCENARIOS.reviewFailThenPass, call: 2 };

    assert.deepEqual(await inspect(Object.create(options)), await inspect(options));
  });
});
