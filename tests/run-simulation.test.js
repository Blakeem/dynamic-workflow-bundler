import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { RUNTIME_GLOBAL_NAMES } from '../src/contract.js';
import { runSimulation, SCRIPT_TIME_LIMIT_MS } from '../src/run-simulation.js';

const FIXTURES = new URL('./fixtures/runtime/', import.meta.url);
const META = "export const meta = { name: 'p', description: 'd' }\n";
const PROBES = ['sim-probe-values', 'sim-probe-boundary', 'sim-probe-names'];
const OTHER_ENGINE = 'the text is written by another JavaScript engine';
const SESSION_VALUE = 'the value belongs to the session that measured it';
const CALLS_AGENT = 'the key calls agent()';
const NO_CHILD_SCRIPT = 'workflow() runs no child script in a simulation';
const LEFT_OUT_REASONS = [OTHER_ENGINE, SESSION_VALUE, CALLS_AGENT, NO_CHILD_SCRIPT];
// The probe keys whose measured text no simulation can give, each with its reason.
const LEFT_OUT_KEYS = [
  { probe: 'sim-probe-values', key: 'budget spent', reason: SESSION_VALUE },
  { probe: 'sim-probe-values', key: 'workflow unknown name', reason: NO_CHILD_SCRIPT },
  { probe: 'sim-probe-values', key: 'workflow missing path', reason: NO_CHILD_SCRIPT },
  { probe: 'sim-probe-values', key: 'agent schema array', reason: CALLS_AGENT },
  { probe: 'sim-probe-values', key: 'agent schema null', reason: CALLS_AGENT },
  { probe: 'sim-probe-values', key: 'agent opts string', reason: CALLS_AGENT },
  { probe: 'sim-probe-names', key: 'agent schema string', reason: CALLS_AGENT },
  { probe: 'sim-probe-names', key: 'agent schema root array type', reason: CALLS_AGENT },
  { probe: 'sim-probe-names', key: 'agent unknown agentType', reason: CALLS_AGENT },
  { probe: 'sim-probe-names', key: 'budget assign', reason: OTHER_ENGINE },
];
const MAXIMUM_LEFT_OUT_KEYS = 16;
// The names this project's context defines, apart from the ones a Node context already has.
const STAND_IN_NAMES = ['__wRg$loop', '__wRg$resolve', 'agent', 'args', 'budget', 'clearTimeout', 'console', 'log', 'parallel', 'phase', 'pipeline', 'setTimeout', 'then', 'workflow'];

/**
 * @param {string} name
 * @returns {Promise<any>}
 */
async function readJsonFixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8'));
}

/**
 * @param {string} body The script after its meta statement.
 * @param {Partial<import('../src/run-simulation.js').SimulationOptions>} [options]
 * @param {number} [scriptTimeLimit]
 */
function simulateBody(body, options = {}, scriptTimeLimit = undefined) {
  return runSimulation(`${META}${body}`, { answerCall: () => null, ...options }, scriptTimeLimit);
}

const probes = await Promise.all(PROBES.map(async (probe) => ({
  probe,
  text: await readFile(new URL(`${probe}.js`, FIXTURES), 'utf8'),
  measured: await readJsonFixture(`${probe}.measured.json`),
})));
const returnScripts = (await readJsonFixture('return-scripts.measured.json')).scripts;

for (const { probe, text, measured } of probes) {
  describe(`${probe}.js, as Claude Code ${measured.measuredOn} ran it`, () => {
    let simulation = null;
    const simulate = () => (simulation ??= runSimulation(text, { args: measured.args, answerCall: () => 'answer' }));

    for (const key of Object.keys(measured.result)) {
      if (LEFT_OUT_KEYS.some((row) => row.probe === probe && row.key === key)) continue;
      it(`gives the runtime's outcome for "${key}"`, async () => {
        const { end } = await simulate();

        assert.equal(end.kind, 'returned');
        assert.equal(end.value[key], measured.result[key]);
      });
    }

    it("records the runtime's log lines", async () => {
      assert.deepEqual((await simulate()).logs, measured.logs);
    });
  });
}

describe('left-out probe keys', () => {
  it(`holds at most ${MAXIMUM_LEFT_OUT_KEYS} rows, each a key a probe holds, with an allowed reason`, () => {
    assert.ok(LEFT_OUT_KEYS.length <= MAXIMUM_LEFT_OUT_KEYS);
    for (const row of LEFT_OUT_KEYS) {
      const probe = probes.find((entry) => entry.probe === row.probe);

      assert.ok(Object.hasOwn(probe.measured.result, row.key), `${row.probe}: ${row.key}`);
      assert.ok(LEFT_OUT_REASONS.includes(row.reason), `${row.probe}: ${row.key}`);
    }
  });
});

describe('the end of a script', () => {
  for (const [id, entry] of Object.entries(returnScripts)) {
    if (entry.script === null) continue;
    it(`${id} ends as the runtime reported it`, async () => {
      const { end } = await simulateBody(entry.script);

      if (entry.status === 'completed') {
        assert.deepEqual(end, { kind: 'returned', value: entry.result });
      } else {
        assert.equal(end.kind, 'threw');
        assert.equal(`${end.name}: ${end.message}`, entry.result);
      }
    });
  }

  it("gives the runtime's error text for a return that holds a BigInt", async () => {
    const { end } = await simulateBody('return { list: [1n] }');

    assert.equal(`${end.name}: ${end.message}`, returnScripts['return-g'].result);
  });

  it('gives null for a return of undefined or of a symbol', async () => {
    assert.deepEqual((await simulateBody('return undefined')).end, { kind: 'returned', value: null });
    assert.deepEqual((await simulateBody("return Symbol('s')")).end, { kind: 'returned', value: null });
  });

  it('gives a thrown value with no message as a string, and the name of an error a runtime function throws', async () => {
    assert.deepEqual((await simulateBody('throw 7')).end, { kind: 'threw', name: 'Error', message: '7' });
    assert.deepEqual((await simulateBody('throw { code: 7 }')).end, { kind: 'threw', name: 'Error', message: '[object Object]' });
    assert.deepEqual((await simulateBody("await parallel('x')")).end, { kind: 'threw', name: 'TypeError', message: 'parallel() expects an array of functions' });
    assert.deepEqual((await simulateBody("throw new RangeError('far')")).end, { kind: 'threw', name: 'RangeError', message: 'far' });
  });
});

describe('the context', () => {
  it('holds each runtime global name that Node or the stand-in defines, and no other own name', async () => {
    const nodeNames = new Set(runInContext('Object.getOwnPropertyNames(globalThis)', createContext({})));
    const expected = RUNTIME_GLOBAL_NAMES.filter((name) => nodeNames.has(name) || STAND_IN_NAMES.includes(name)).sort();
    const { end } = await simulateBody('return Object.getOwnPropertyNames(globalThis).sort()');

    assert.deepEqual(end.value, expected);
  });

  it('runs the body as the body of a strict async arrow function compiled as workflow.js, which cannot read meta', async () => {
    const { end } = await simulateBody("await null\nconst stack = new Error('x').stack\nreturn [typeof meta, (function () { return this })() === undefined, stack.includes('workflow.js')]");

    assert.deepEqual(end.value, ['undefined', true, true]);
  });

  it('refuses code generation from strings', async () => {
    const { end } = await simulateBody("return Function('return 1')()");

    assert.deepEqual(end, { kind: 'threw', name: 'EvalError', message: 'Code generation from strings disallowed for this context' });
  });

  it('throws on each way to read the clock or a random number when it is called, and on no read', async () => {
    const body = [
      'const out = []',
      "const attempt = (run) => { try { out.push('ok ' + run()) } catch (error) { out.push((error instanceof Error) + ' ' + error.message.slice(0, 15)) } }",
      'attempt(() => Date.now())',
      'attempt(() => Date())',
      'attempt(() => Date(0))',
      'attempt(() => new Date())',
      'attempt(() => { const { now } = Date; return now() })',
      'attempt(() => new (new Date(0).constructor)())',
      'attempt(() => Reflect.construct(Date, []))',
      'attempt(() => Math.random.call(Math))',
      'attempt(() => new Date(0).toISOString())',
      'attempt(() => String(new Date(undefined).getTime()))',
      "attempt(() => Date.parse('2026-01-01T00:00:00Z') === Date.UTC(2026, 0, 1))",
      'attempt(() => typeof Date.now + typeof Math.random)',
      'attempt(() => new Date(0) instanceof Date)',
      'return out',
    ].join('\n');
    const clockError = 'true Date.now() / ne';
    const randomError = 'true Math.random() i';
    const { end } = await simulateBody(body);

    assert.deepEqual(end.value, [clockError, clockError, clockError, clockError, clockError, clockError, clockError, randomError, 'ok 1970-01-01T00:00:00.000Z', 'ok NaN', 'ok true', 'ok functionfunction', 'ok true']);
  });

  it('gives the budget it is passed, and no spent past its total', async () => {
    const body = 'return [budget.total, budget.spent(), budget.remaining()]';

    assert.deepEqual((await simulateBody(body, { budget: { total: 100, spent: 30 } })).end.value, [100, 30, 70]);
    assert.deepEqual((await simulateBody(body, { budget: { total: 10, spent: 30 } })).end.value, [10, 30, 0]);
    assert.deepEqual((await simulateBody(body, { budget: { total: null } })).end.value, [null, 0, null]);
  });

  it('answers each agent() call with what answerCall gives, and rejects the call when answerCall throws', async () => {
    const calls = [];
    const answerCall = (call) => {
      calls.push(call);
      if (call.prompt === 'fail') throw new Error('no answer');
      return { answered: call.prompt };
    };
    const body = "const first = await agent('one', { label: 'l' })\nlet failure = null\ntry { await agent('fail') } catch (error) { failure = error.message }\nreturn [first, failure]";
    const { end } = await simulateBody(body, { answerCall });

    assert.deepEqual(end.value, [{ answered: 'one' }, 'no answer']);
    // The options are an object of the script's realm, so they compare as JSON text.
    assert.deepEqual(calls.map((call) => [call.prompt, JSON.stringify(call.opts), call.group]), [['one', '{"label":"l"}', null], ['fail', undefined, null]]);
  });

  it('waits for an answer that answerCall gives as a promise, runs a timer only once no answer is pending, and rejects the call when it rejects', async () => {
    const answerCall = (call) => new Promise((resolve, reject) => setTimeout(() => (call.prompt === 'fail' ? reject(new Error('late failure')) : resolve('late')), 20));
    const body = "const timer = new Promise((resolve) => setTimeout(() => resolve('timer'), 0))\nconst answer = agent('x')\nconst failure = agent('fail').catch((error) => error.message)\nconst first = await Promise.race([answer, timer])\nreturn [first, await answer, await timer, await failure]";

    assert.deepEqual((await simulateBody(body, { answerCall })).end.value, ['late', 'late', 'timer', 'late failure']);
  });

  it('records nothing that the script does after it ends', async () => {
    const answerCall = () => new Promise((resolve) => setTimeout(() => resolve('late'), 10));
    // The getter runs while the return is converted, and its chain runs once the simulation has ended.
    const body = [
      "agent('x').then(() => log('late answer'))",
      'return { get value() {',
      '  let later = Promise.resolve()',
      '  for (let index = 0; index < 5; index += 1) later = later.then(() => null)',
      "  later.then(() => { log('late'); phase('late'); parallel([]); pipeline([]) })",
      "  return 'early'",
      '} }',
    ].join('\n');
    const result = await simulateBody(body, { answerCall });

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(result, { end: { kind: 'returned', value: { value: 'early' } }, logs: [], phases: [], groups: [] });
  });

  it('rejects options it cannot pass to the script, and a script the runtime refuses', async () => {
    await assert.rejects(runSimulation(`${META}return 1`, {}), { name: 'TypeError', message: /answerCall/ });
    await assert.rejects(simulateBody('return 1', { args: () => 1 }), { name: 'TypeError', message: /options\.args/ });
    await assert.rejects(simulateBody('return 1', { args: { count: 1n } }), { name: 'TypeError', message: /options\.args.*BigInt/ });
    await assert.rejects(simulateBody('return 1', { budget: 5 }), { name: 'TypeError', message: /options\.budget must/ });
    await assert.rejects(simulateBody('return 1', { budget: { total: '5' } }), { name: 'TypeError', message: /budget\.total/ });
    await assert.rejects(simulateBody('return 1', { budget: { spent: '5' } }), { name: 'TypeError', message: /budget\.spent/ });
    await assert.rejects(runSimulation('return 1', { answerCall: () => null }), /export const meta/);
    await assert.rejects(simulateBody('const value = ;'), SyntaxError);
  });
});

describe('time', () => {
  it('runs each timer once no other code can run, by due time and then call order, with no real wait', async () => {
    const body = [
      'const order = []',
      "const cancelled = setTimeout(() => order.push('cancelled'), 5)",
      'clearTimeout(cancelled)',
      "setTimeout(() => order.push('first at 10'), 10)",
      "setTimeout(() => order.push('second at 10'), 10)",
      "setTimeout(() => order.push('at 5'), 5)",
      "setTimeout(() => order.push('no delay'))",
      "setTimeout('not a function', 0)",
      "setTimeout(() => { throw new Error('ends nothing') }, 1)",
      "Promise.resolve().then(() => order.push('microtask'))",
      'await new Promise((resolve) => setTimeout(resolve, 60000))',
      "return order.join(', ')",
    ].join('\n');
    const started = performance.now();
    const { end } = await simulateBody(body);

    assert.equal(end.value, 'microtask, no delay, at 5, first at 10, second at 10');
    assert.ok(performance.now() - started < 5000);
  });
});

describe('the time limit', () => {
  it(`stops code before the first await past the limit, with the runtime's message for ${SCRIPT_TIME_LIMIT_MS} ms, and no code after it`, async () => {
    const limit = 5;
    const stopped = await simulateBody('while (true) {}', {}, limit);
    const awaited = await simulateBody('await null\nlet total = 0\nfor (let index = 0; index < 1e8; index += 1) total += index\nreturn total > 0', {}, limit);

    assert.deepEqual(stopped.end, { kind: 'threw', name: 'Error', message: `Script execution timed out after ${SCRIPT_TIME_LIMIT_MS}ms` });
    assert.deepEqual(awaited.end, { kind: 'returned', value: true });
  });
});

describe('a script that can never continue', () => {
  it('ends with an error, and an unhandled rejection before it ends nothing', async () => {
    const { end } = await simulateBody("Promise.reject(new Error('unhandled'))\nawait new Promise(() => {})");

    assert.deepEqual(end, { kind: 'threw', name: 'Error', message: 'The script waits on a promise that never settles' });
  });
});

describe('groups and phases', () => {
  it('stamps each call with its group, item and stage across an await, a then and a timer, and counts the calls before each phase', async () => {
    const calls = [];
    const answerCall = (call) => {
      calls.push(call);
      return call.prompt;
    };
    const body = [
      "phase('One')",
      "await agent('top')",
      'await parallel([',
      "  () => agent('thunk 0'),",
      "  async () => { await null; return agent('thunk 1') },",
      "  () => Promise.resolve().then(() => agent('thunk 2')),",
      "  () => new Promise((resolve) => setTimeout(() => resolve(agent('thunk 3')), 10)),",
      '])',
      'phase(2)',
      "await pipeline(['a', 'b'], (item) => agent('stage 0 ' + item), (previous, item) => agent('stage 1 ' + item))",
      "await agent('last')",
    ].join('\n');
    const result = await simulateBody(body, { answerCall });
    const stamps = Object.fromEntries(calls.map((call) => [call.prompt, call.group]));

    assert.deepEqual(result.end, { kind: 'returned', value: null });
    assert.deepEqual(stamps, {
      top: null,
      'thunk 0': { group: 0, item: 0, stage: 0 },
      'thunk 1': { group: 0, item: 1, stage: 0 },
      'thunk 2': { group: 0, item: 2, stage: 0 },
      'thunk 3': { group: 0, item: 3, stage: 0 },
      'stage 0 a': { group: 1, item: 0, stage: 0 },
      'stage 0 b': { group: 1, item: 1, stage: 0 },
      'stage 1 a': { group: 1, item: 0, stage: 1 },
      'stage 1 b': { group: 1, item: 1, stage: 1 },
      last: null,
    });
    assert.deepEqual(result.groups, [{ kind: 'parallel', items: 4, stages: 1 }, { kind: 'pipeline', items: 2, stages: 2 }]);
    assert.deepEqual(result.phases, [{ title: 'One', beforeCall: 0 }, { title: '2', beforeCall: 5 }]);
  });
});
