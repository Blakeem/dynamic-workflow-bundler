import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { simulate, validate } from 'dynamic-workflow-bundler';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { READ_BYTE_LIMIT } from '../src/read-byte-limit.js';
import { formatRealDisplayPath } from '../src/real-path.js';
import { listMissingGlobalNames } from '../src/run-simulation.js';
import { SCENARIOS } from './fixtures/simulate/scenarios.js';
import { writeSizedFile } from './support/write-sized-file.js';

const FIXTURES = new URL('./fixtures/simulate/', import.meta.url);

const temporaryFolders = [];
after(async () => {
  for (const folder of temporaryFolders) await rm(folder, { recursive: true, force: true });
});

/**
 * @param {string} name A script of tests/fixtures/simulate/, without its ending.
 * @returns {string}
 */
function findFixture(name) {
  return fileURLToPath(new URL(`${name}.js`, FIXTURES));
}

/**
 * @param {string} name
 * @param {string} body The script after its meta statement.
 * @returns {Promise<string>} The path of a new script in a new folder.
 */
async function writeScript(name, body) {
  const folder = await mkdtemp(join(tmpdir(), 'dwfb-simulate-'));
  const script = join(folder, name);

  temporaryFolders.push(folder);
  await writeFile(script, `export const meta = { name: 'p', description: 'd' }\n${body}`);
  return script;
}

/**
 * Simulates a script, and checks that JSON keeps the entire trace.
 * @param {string} script
 * @param {import('../src/simulate.js').Scenario} [scenario]
 * @returns {Promise<import('../src/simulate.js').Trace>}
 */
async function simulateScript(script, scenario = undefined) {
  const trace = await simulate(scenario === undefined ? { script } : { script, scenario });

  assert.deepEqual(JSON.parse(JSON.stringify(trace)), trace);
  return trace;
}

/**
 * @param {string} name
 * @param {import('../src/simulate.js').Scenario} [scenario]
 */
function simulateFixture(name, scenario = undefined) {
  return simulateScript(findFixture(name), scenario);
}

describe('simulate options', () => {
  it('rejects options of another shape with a UsageError, as validate() does', async () => {
    const script = findFixture('budget-args');

    await assert.rejects(simulate(null), { name: 'UsageError', message: 'simulate() takes an options object' });
    await assert.rejects(simulate({ script, scenarios: [] }), { name: 'UsageError', message: 'simulate() takes no option scenarios' });
    await assert.rejects(simulate({}), { name: 'UsageError', message: 'simulate() needs script, the path of a workflow script' });
    await assert.rejects(simulate({ script: findFixture('missing') }), { name: 'UsageError', message: /does not exist/ });
    await assert.rejects(simulate({ script, scenario: [] }), { name: 'UsageError', message: /takes scenario, an object/ });
  });

  it('rejects a scenario with an unknown key or a value of another shape', async () => {
    const script = findFixture('budget-args');
    const rejectScenario = (scenario, message) => assert.rejects(simulate({ script, scenario }), { name: 'UsageError', message });

    await rejectScenario({ respnd: {} }, 'The scenario takes no key respnd');
    await rejectScenario({ name: 7 }, 'The scenario name must be a string');
    await rejectScenario({ args: { list: [() => 1] } }, 'The scenario args hold a function at list[0], which JSON cannot carry');
    await rejectScenario({ args: 1n }, 'The scenario args are a BigInt, which JSON cannot carry');
    await rejectScenario({ respond: ['x'] }, 'The scenario respond must be an object keyed by label prefix, or a function');
    await rejectScenario({ respond: 'x' }, 'The scenario respond must be an object keyed by label prefix, or a function');
    await rejectScenario({ respond: new Map([['review', 'pass']]) }, 'The scenario respond must be an object keyed by label prefix, or a function');
    await rejectScenario({ budget: 5 }, 'The scenario budget must be an object of total, spent and spentPerCall');
    await rejectScenario({ budget: { totl: 5 } }, 'The scenario budget takes no key totl');
    for (const total of ['5', Number.NaN, -1]) {
      await rejectScenario({ budget: { total } }, 'The scenario budget total must be null or a number of 0 or more');
    }
    for (const spent of ['5', Number.NaN, Number.POSITIVE_INFINITY, -1, null]) {
      await rejectScenario({ budget: { spent } }, 'The scenario budget spent must be a finite number of 0 or more');
    }
    for (const spentPerCall of ['5', -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      await rejectScenario({ budget: { spentPerCall } }, 'The scenario budget spentPerCall must be a finite number of 0 or more');
    }
  });

  it("passes the scenario's args and budget to the script", async () => {
    const trace = await simulateFixture('budget-args', { args: { list: [1] }, budget: { total: 10, spent: 4 } });

    assert.deepEqual(trace.end, { kind: 'returned', value: { args: { list: [1] }, total: 10, spent: 4, remaining: 6 } });
    assert.deepEqual((await simulateFixture('budget-args')).end, { kind: 'returned', value: { total: null, spent: 0, remaining: null } });
    assert.deepEqual((await simulateFixture('budget-args', { budget: { total: 0, spent: 0 } })).end, { kind: 'returned', value: { total: 0, spent: 0, remaining: 0 } });
  });

  it('adds spentPerCall to spent for each call that got a scripted return, so a script can stop between steps', async () => {
    const respond = { '': (call) => `${call.label} done` };
    const stopsEarly = await simulateFixture('budget-steps', { respond, budget: { total: 100, spent: 0, spentPerCall: 40 } });
    const runsAll = await simulateFixture('budget-steps', { respond, budget: { total: 100, spent: 10 } });

    assert.deepEqual(stopsEarly.end, { kind: 'returned', value: { done: ['plan done', 'build done'], spent: 80 } });
    assert.equal(stopsEarly.calls.length, 2);
    assert.deepEqual(runsAll.end, { kind: 'returned', value: { done: ['plan done', 'build done', 'review done'], spent: 10 } });
  });
});

describe('the trace', () => {
  it('records three calls in a parallel with their group stamps, the group, the phase and the log', async () => {
    const script = findFixture('parallel-plans');
    const trace = await simulateScript(script, SCENARIOS.plansAnswered);
    const plans = ['plan for plan parser', 'plan for plan loader', 'plan for plan writer'];

    assert.deepEqual(trace, {
      script: await formatRealDisplayPath(script),
      scenario: 'every plan answered',
      runtime: CONTRACT_RUNTIME_VERSION,
      end: { kind: 'returned', value: plans },
      calls: [
        { index: 0, label: 'plan parser', prompt: 'Plan the parser', opts: { label: 'plan parser' }, group: { group: 0, item: 0, stage: 0 }, phase: 'Plan', returned: plans[0] },
        { index: 1, label: 'plan loader', prompt: 'Plan the loader', opts: { label: 'plan loader' }, group: { group: 0, item: 1, stage: 0 }, phase: 'Plan', returned: plans[1] },
        { index: 2, label: 'plan writer', prompt: 'Plan the writer', opts: { label: 'plan writer' }, group: { group: 0, item: 2, stage: 0 }, phase: 'Plan', returned: plans[2] },
      ],
      groups: [{ kind: 'parallel', items: 3, stages: 1 }],
      phases: [{ title: 'Plan', beforeCall: 0 }],
      logs: ['plans: 3'],
      events: [{ kind: 'phase', index: 0 }, { kind: 'call', index: 0 }, { kind: 'call', index: 1 }, { kind: 'call', index: 2 }, { kind: 'log', index: 0 }],
    });
  });

  it('answers a review loop from a list, fail then pass', async () => {
    const trace = await simulateFixture('review-loop', SCENARIOS.reviewFailThenPass);

    assert.deepEqual(trace.end, { kind: 'returned', value: { status: 'passed', round: 2 } });
    assert.deepEqual(trace.calls.map((call) => [call.label, call.prompt, call.returned]), [
      ['draft', 'Write the draft', 'the draft'],
      ['review', 'Review round 1: the draft', { verdict: 'fail' }],
      ['review', 'Review round 2: the draft', { verdict: 'pass' }],
    ]);
  });

  it('gives null to the script for an agent that died', async () => {
    const trace = await simulateFixture('review-loop', SCENARIOS.reviewerDied);

    assert.deepEqual(trace.end, { kind: 'returned', value: { status: 'reviewer died', round: 1 } });
    assert.equal(trace.calls[1].returned, null);
  });

  it('records the label only when it is a string, the prompt as a string, and a JSON copy of the options or null', async () => {
    const calls = [{ label: 'review', model: 'fast' }, null, { label: 5 }];
    const trace = await simulateFixture('call-each', { args: { calls }, respond: { '': 'any' } });

    assert.deepEqual(trace.calls.map((call) => [call.index, call.label, call.prompt, call.opts, call.group]), [
      [0, 'review', 'Prompt 0', { label: 'review', model: 'fast' }, null],
      [1, null, 'Prompt 1', null, null],
      [2, null, 'Prompt 2', { label: 5 }, null],
    ]);
    assert.equal(trace.scenario, null);
  });

  it('records null for options JSON cannot hold, drops their functions, and records a prompt that is not a string as a string', async () => {
    const trace = await simulateFixture('opts-kinds', { respond: { '': 'any' } });

    assert.deepEqual(trace.calls.map((call) => [call.label, call.prompt, call.opts]), [
      ['big', 'BigInt', null],
      ['cycle', 'Cycle', null],
      ['run', 'Function', { label: 'run' }],
      [null, '42', null],
    ]);
    assert.deepEqual(trace.end, { kind: 'returned', value: 'done' });
  });

  it("gives the script a copy of each scripted return made of its realm's objects, so a change reaches no other call", async () => {
    const trace = await simulateFixture('copy-return', SCENARIOS.recordShared);

    assert.deepEqual(trace.end, { kind: 'returned', value: { isScriptRealm: true, second: ['kept'] } });
    assert.deepEqual(trace.calls[0].returned, { items: ['kept'] });
    assert.deepEqual(SCENARIOS.recordShared.respond, { record: { items: ['kept'] } });
  });
});

describe('a stop', () => {
  it('stops at a call that no key answers, which a parallel does not turn into null', async () => {
    const trace = await simulateFixture('parallel-plans', SCENARIOS.writerUnanswered);

    assert.deepEqual(trace.end, {
      kind: 'stopped',
      reason: 'unanswered',
      message: "No key of respond matches call 2 (label \"plan writer\"). Add a key that the label starts with, or the key ''",
      call: 2,
    });
    assert.equal(trace.calls.length, 3);
    assert.ok(!Object.hasOwn(trace.calls[2], 'returned'));
    assert.deepEqual(trace.logs, []);
  });

  it('stops at a call past the end of its list', async () => {
    const trace = await simulateFixture('review-loop', SCENARIOS.reviewUsedUp);

    assert.equal(trace.end.reason, 'unanswered');
    assert.equal(trace.end.call, 2);
    assert.match(trace.end.message, /list of key "review" holds 1 scripted return, which earlier calls used up/);
  });

  it('stops at a call that gets a value of the wrong type', async () => {
    const trace = await simulateFixture('review-loop', SCENARIOS.reviewString);

    assert.deepEqual(trace.end, {
      kind: 'stopped',
      reason: 'wrong-type',
      message: 'Key "review" of respond gives call 1 (label "review") a string, and a call with a schema takes a plain object or null. Give it a plain object or null',
      call: 1,
    });
  });

  it('stops at a call whose scripted return holds a value JSON cannot carry', async () => {
    const trace = await simulateFixture('review-loop', SCENARIOS.reviewDate);

    assert.equal(trace.end.reason, 'not-json');
    assert.match(trace.end.message, /holds a Date at reviewedAt, which JSON cannot carry/);
  });

  it('is not an error that a try and catch around agent() catches', async () => {
    const trace = await simulateFixture('catch-agent', SCENARIOS.answerUnanswered);

    assert.equal(trace.end.kind, 'stopped');
    assert.equal(trace.end.reason, 'unanswered');
    assert.deepEqual(trace.logs, []);
  });

  it('rejects with a UsageError that names the call when a respond function throws', async () => {
    const script = findFixture('catch-agent');
    const scriptPath = await formatRealDisplayPath(script);
    const rejectRespond = (respond, message) => assert.rejects(simulate({ script, scenario: { respond } }), { name: 'UsageError', message });

    await assert.rejects(simulate({ script, scenario: SCENARIOS.respondThrows }), {
      name: 'UsageError',
      message: 'The scenario\'s respond threw at call 0 (label "answer"). No answer written',
    });
    await rejectRespond(() => { throw new Error(`${script} is unread.`); }, `The scenario's respond threw at call 0 (label "answer"). ${scriptPath} is unread`);
    await rejectRespond(() => { throw new Error(''); }, 'The scenario\'s respond threw at call 0 (label "answer"). Its code threw a value that has no text');
  });

  it('ignores a stop at a call made after the script settled, and records only a late call that got a scripted return', async () => {
    const unanswered = await simulateFixture('late-call', SCENARIOS.answerUnanswered);
    const respondThrew = await simulateFixture('late-call', SCENARIOS.respondThrows);
    const answered = await simulateFixture('late-call', { respond: { late: 'late return' } });

    assert.deepEqual([unanswered.end, unanswered.calls, unanswered.events], [{ kind: 'returned', value: 'done' }, [], []]);
    assert.deepEqual([respondThrew.end, respondThrew.calls], [{ kind: 'returned', value: 'done' }, []]);
    assert.deepEqual(answered.calls, [{ index: 0, label: 'late', prompt: 'Late', opts: { label: 'late' }, group: null, phase: null, returned: 'late return' }]);
  });

  const missingName = listMissingGlobalNames().includes('Temporal') ? null : `Node ${process.version} defines Temporal`;
  it('stops before the script runs when it reads a runtime name this Node lacks', { skip: missingName ?? false }, async () => {
    const trace = await simulateFixture('reads-temporal');

    assert.deepEqual(trace.end, {
      kind: 'stopped',
      reason: 'node-lacks-name',
      message: `The script reads Temporal, which the runtime defines and Node ${process.version} does not, so the simulation cannot run it. Run it on a Node that defines Temporal`,
    });
    assert.deepEqual([trace.calls, trace.events], [[], []]);
  });

  it('stops with no call when the script waits on a promise that nothing settles', async () => {
    const trace = await simulateScript(await writeScript('waits.js', "log('waiting')\nawait new Promise(() => {})\n"));

    assert.deepEqual(trace.end, {
      kind: 'stopped',
      reason: 'never-settles',
      message: 'The script waits on a promise that nothing settles. A run of this script would not end',
    });
    assert.deepEqual([trace.calls, trace.logs], [[], ['waiting']]);
  });

  // The loop of each test that uses it never ends without the cap, so the timeout fails the test rather than hang the suite.
  const CALL_LIMIT_TEST_TIMEOUT = 60_000;

  it('stops at the call after the 1000th, the cap the runtime puts on one workflow, and answers the 1000th', { timeout: CALL_LIMIT_TEST_TIMEOUT }, async () => {
    const findLoop = "const bugs = [];\nwhile (bugs.length < 10) {\n  const found = await agent('Find bugs', { label: 'find', schema: { type: 'object' } });\n  bugs.push(...found.bugs);\n}\nreturn bugs;\n";
    const capped = await simulateScript(await writeScript('find-loop.js', findLoop), { respond: { find: { bugs: [] } } });
    const counted = await simulateScript(await writeScript('count-calls.js', "for (let index = 0; index < args.count; index += 1) await agent('x');\nreturn args.count;\n"), { args: { count: 1000 }, respond: { '': 'any' } });

    assert.deepEqual(capped.end, {
      kind: 'stopped',
      reason: 'call-limit',
      message: 'The script made more than 1000 agent() calls, the cap the runtime puts on one workflow. Check the code that makes call 1000 (label "find")',
      call: 1000,
    });
    assert.equal(capped.calls.length, 1001);
    assert.deepEqual(capped.calls[999].returned, { bugs: [] });
    assert.ok(!Object.hasOwn(capped.calls[1000], 'returned'));
    assert.deepEqual([counted.end, counted.calls.length], [{ kind: 'returned', value: 1000 }, 1000]);
  });

  it('stops at the cap a loop that waits for a timer between calls it does not await', { timeout: CALL_LIMIT_TEST_TIMEOUT }, async () => {
    const timerLoop = "await agent('a');\nwhile (true) {\n  agent('x');\n  await new Promise((resolve) => setTimeout(resolve, 1));\n}\n";
    const trace = await simulateScript(await writeScript('timer-loop.js', timerLoop), { respond: { '': 'ok' } });

    assert.deepEqual([trace.end.reason, trace.end.call, trace.calls.length], ['call-limit', 1000, 1001]);
  });

  it('stops at a call whose respond function gives a promise, and lets no rejection of it reach the process', async () => {
    const script = await writeScript('answer.js', "return await agent('x')\n");
    const unhandled = [];
    const recordUnhandled = (reason) => unhandled.push(reason);
    let trace = null;

    process.on('unhandledRejection', recordUnhandled);
    try {
      trace = await simulateScript(script, { respond: async () => { throw new Error('boom'); } });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', recordUnhandled);
    }
    assert.equal(trace.end.reason, 'wrong-type');
    assert.match(trace.end.message, /^The respond function gives call 0 \(no label\) a Promise/);
    assert.deepEqual(unhandled, []);
  });
});

describe('a refused script', () => {
  it('runs no code of a script that breaks the contract, and gives the findings validate() gives', async () => {
    const script = findFixture('no-meta');
    const trace = await simulateScript(script, SCENARIOS.answerUnanswered);

    assert.deepEqual(trace.end, { kind: 'refused', findings: (await validate({ script })).findings });
    assert.deepEqual([trace.calls, trace.groups, trace.phases, trace.logs, trace.events], [[], [], [], [], []]);
  });

  it('refuses a script larger than READ_BYTE_LIMIT as validate() refuses it', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-simulate-'));
    const script = join(folder, 'workflow.js');
    temporaryFolders.push(folder);
    await writeSizedFile(script, READ_BYTE_LIMIT + 1);
    const trace = await simulateScript(script);

    assert.deepEqual(trace.end, { kind: 'refused', findings: (await validate({ script })).findings });
    assert.equal(trace.end.findings[0].rule, 'script-too-large');
  });
});

describe('the schema of an agent() call', () => {
  it('throws as the runtime throws for a schema it refuses, and counts null and options that are not an object as no schema', async () => {
    const trace = await simulateFixture('schema-checks', SCENARIOS.schemaChecks);

    assert.deepEqual(trace.end.value, [
      'TelemetrySafeError: agent({schema}) received an invalid JSON Schema: data  | instanceof Error false',
      'TelemetrySafeError: agent({schema}) received an unusable JSON Schema — the | instanceof Error false',
      'TypeError: WeakMap keys must be objects or non-registered symbols | instanceof Error false',
      'TypeError: WeakMap keys must be objects or non-registered symbols | instanceof Error false',
      'ok string',
      'ok string',
      'ok object',
    ]);
    assert.deepEqual(trace.calls.map((call) => call.label), ['null', null, 'object']);
  });
});
