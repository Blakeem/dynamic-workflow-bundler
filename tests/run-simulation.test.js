import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { RUNTIME_GLOBAL_NAMES } from '../src/contract.js';
import { listMissingGlobalNames, runSimulation, SCRIPT_TIME_LIMIT_MS, SimulationStop } from '../src/run-simulation.js';

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
    assert.deepEqual((await simulateBody('throw 7')).end, { kind: 'threw', name: 'Error', message: '7', frames: [] });
    assert.deepEqual((await simulateBody('throw { code: 7 }')).end, { kind: 'threw', name: 'Error', message: '[object Object]', frames: [] });
    assert.deepEqual((await simulateBody("await parallel('x')")).end, { kind: 'threw', name: 'TypeError', message: 'parallel() expects an array of functions', frames: [] });
    assert.deepEqual((await simulateBody("throw new RangeError('far')")).end, { kind: 'threw', name: 'RangeError', message: 'far', frames: [{ line: 2, column: 7 }] });
  });
});

describe('the frames of a thrown error', () => {
  // A meta statement over three lines puts the body's first line on line 3 of the script.
  const TALL_META = "export const meta = { name: 'p',\n  description: 'd',\n}";
  const READ_TIME_LIMIT_MS = 100;
  const CHILD_TIME_LIMIT_MS = 20000;

  /**
   * @param {string} body The text after TALL_META.
   * @param {Partial<import('../src/run-simulation.js').SimulationOptions>} [options]
   */
  async function readFrames(body, options = {}) {
    const { end } = await runSimulation(`${TALL_META}${body}`, { answerCall: () => 'ok', ...options });

    assert.equal(end.kind, 'threw');
    return end.frames;
  }

  it('places a throw new Error at its new keyword, past a meta statement of three lines', async () => {
    assert.deepEqual(await readFrames("\nconst a = 1\n  throw new Error('x')"), [{ line: 5, column: 9 }]);
  });

  it('places a throw on the line where the meta statement ends', async () => {
    assert.deepEqual(await readFrames("; throw new Error('x')"), [{ line: 3, column: 10 }]);
  });

  it('places a throw on the line of a one-line meta statement at the same column with a leading byte order mark as with none', async () => {
    const text = "export const meta = { name: 'p', description: 'd' }; throw new Error('x')";
    const ends = [(await runSimulation(text, { answerCall: () => 'ok' })).end, (await runSimulation(`\uFEFF${text}`, { answerCall: () => 'ok' })).end];

    assert.deepEqual(ends.map((end) => end.frames), [[{ line: 1, column: 60 }], [{ line: 1, column: 60 }]]);
  });

  it('places an error of a class of the script, with and with no constructor', async () => {
    assert.deepEqual(await readFrames("\nclass Gone extends Error {}\nthrow new Gone('x')"), [{ line: 5, column: 7 }]);
    assert.deepEqual(await readFrames("\nclass Late extends Error { constructor(message) { super(message); this.name = 'Late' } }\nthrow new Late('x')"), [{ line: 5, column: 7 }]);
  });

  it('lists the frame of the function that created the error, then its caller', async () => {
    assert.deepEqual(await readFrames("\nconst make = () => new Error('made')\nconst error = make()\nthrow error"), [{ line: 4, column: 20 }, { line: 5, column: 15 }]);
  });

  it('counts a CR LF and a lone CR as one line break each, and U+2028 as none', async () => {
    assert.deepEqual(await readFrames("\rconst a = 1\r  throw new Error('x')"), [{ line: 5, column: 9 }]);
    assert.deepEqual(await readFrames("\r\nconst note = 'a b'\r\n throw new Error(note)"), [{ line: 5, column: 8 }]);
  });

  it('places a TypeError of a property read of undefined at the read, then the place that invokes its function', async () => {
    assert.deepEqual(await readFrames('\nconst read = (value) => value.name\nread(undefined)'), [{ line: 4, column: 31 }, { line: 5, column: 1 }]);
  });

  it('leaves out the call site of Array.prototype.map between a callback and its caller', async () => {
    assert.deepEqual(await readFrames("\nconst list = [1].map(() => { throw new Error('x') })"), [{ line: 4, column: 36 }, { line: 4, column: 18 }]);
  });

  it('lists 10 frames of a deep recursion, whatever the --stack-trace-limit of the Node process', () => {
    const moduleUrl = new URL('../src/run-simulation.js', import.meta.url).href;
    const text = `${TALL_META}\nconst recurse = () => recurse()\nrecurse()`;
    const code = `import { runSimulation } from '${moduleUrl}'; const { end } = await runSimulation(${JSON.stringify(text)}, { answerCall: () => 'ok' }); process.stdout.write(JSON.stringify(end.frames));`;
    const { stdout, stderr } = spawnSync(process.execPath, ['--stack-trace-limit=50', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: CHILD_TIME_LIMIT_MS });

    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), Array(10).fill({ line: 4, column: 23 }));
  });

  it('gives a list of this realm for a script that replaced its array methods', async () => {
    assert.deepEqual(await readFrames("\nArray.prototype.filter = Array.prototype.map = () => []\nthrow new Error('x')"), [{ line: 5, column: 7 }]);
  });

  it('places an error that a getter of the returned value throws', async () => {
    assert.deepEqual(await readFrames("\nreturn { get x() { throw new Error('x') } }"), [{ line: 4, column: 26 }]);
  });

  it('gives no frame for a return the runtime cannot report, a thrown string, a stack the script read, a stack getter that throws, a global Error that is not an object, a frozen Error, a stack trace limit of 0 and an error agent() throws', async () => {
    assert.deepEqual(await readFrames("\nthrow { message: 'm', get stack() { throw 1 } }"), []);
    assert.deepEqual(await readFrames("\nglobalThis.Error = undefined\nthrow new RangeError('x')"), []);
    assert.deepEqual(await readFrames('\nreturn () => 1'), []);
    assert.deepEqual(await readFrames('\nconst loop = {}\nloop.self = loop\nreturn loop'), []);
    assert.deepEqual(await readFrames("\nthrow 'x'"), []);
    assert.deepEqual(await readFrames("\nconst error = new Error('x')\nerror.stack\nthrow error"), []);
    assert.deepEqual(await readFrames("\nObject.freeze(Error)\nthrow new Error('x')"), []);
    assert.deepEqual(await readFrames("\nError.stackTraceLimit = 0\nthrow new Error('x')"), []);
    assert.deepEqual(await readFrames("\nawait agent('p', { schema: 'x' })"), []);
  });

  it("puts the script's Error.prepareStackTrace back as it was: absent, or the script's own function", async () => {
    const realms = [];
    const answerCall = ({ opts }) => {
      realms.push(opts);
      return 'ok';
    };
    const absentFrames = await readFrames("\nawait agent('p', { realmError: Error })\nthrow new Error('x')", { answerCall });
    const ownFrames = await readFrames("\nconst own = () => 'own'\nError.prepareStackTrace = own\nawait agent('p', { realmError: Error, own })\nthrow new Error('x')", { answerCall });
    const [absent, own] = realms;

    assert.deepEqual(absentFrames, [{ line: 5, column: 7 }]);
    assert.equal(Object.hasOwn(absent.realmError, 'prepareStackTrace'), false);
    assert.deepEqual(ownFrames, [{ line: 7, column: 7 }]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(own.realmError, 'prepareStackTrace'), { value: own.own, writable: true, enumerable: true, configurable: true });
  });

  it("sets the hook and puts back the script's own prepareStackTrace for a script that gave Object.prototype a get key", async () => {
    const realms = [];
    const answerCall = ({ opts }) => {
      realms.push(opts);
      return 'ok';
    };
    const addGet = "Object.defineProperty(Object.prototype, 'get', { value: () => 1, configurable: true })";
    const absentFrames = await readFrames(`\n${addGet}\nthrow new Error('x')`);
    const ownFrames = await readFrames(`\nconst own = () => 'own'\nError.prepareStackTrace = own\n${addGet}\nawait agent('p', { realmError: Error, own })\nthrow new Error('x')`, { answerCall });
    const [own] = realms;

    assert.deepEqual(absentFrames, [{ line: 5, column: 7 }]);
    assert.deepEqual(ownFrames, [{ line: 8, column: 7 }]);
    assert.equal(Object.getOwnPropertyDescriptor(own.realmError, 'prepareStackTrace').value, own.own);
  });

  it('gives no frame for a compiled offset that is not an integer, from call sites the script hands the hook', async () => {
    const forged = "{ getFileName: () => 'workflow.js', getPosition: () => COMPILED_OFFSET }";
    const callSites = [forged.replace('COMPILED_OFFSET', '({ valueOf: () => 28 })'), forged.replace('COMPILED_OFFSET', '28.5')].join(', ');

    assert.deepEqual(await readFrames(`\nthrow { message: 'm', get stack() { Error.prepareStackTrace({}, [${callSites}]); return '' } }`), []);
  });

  it('gives no frame and keeps the name and the message for a stack getter or a trap of a Proxy the script made its Error that never returns, and leaves the global names as they were', () => {
    const moduleUrl = new URL('../src/run-simulation.js', import.meta.url).href;
    const handOver = "\nawait agent('p', { scriptGlobal: globalThis, before: Object.getOwnPropertyNames(globalThis) })";
    const texts = [
      `${TALL_META}${handOver}\nthrow { message: 'm', get stack() { while (true) {} } }`,
      `${TALL_META}${handOver}\nglobalThis.Error = new Proxy(Error, { getOwnPropertyDescriptor() { while (true) {} } })\nthrow new RangeError('x')`,
    ];
    // A child process, since a read with no time limit holds the event loop, and a test timer then never fires.
    const code = `import { runSimulation } from '${moduleUrl}'; const results = []; for (const text of ${JSON.stringify(texts)}) { let opts = null; const { end } = await runSimulation(text, { answerCall: (call) => { opts = call.opts; return 'ok' } }, ${READ_TIME_LIMIT_MS}); results.push({ end, names: Object.getOwnPropertyNames(opts.scriptGlobal), before: [...opts.before] }) } process.stdout.write(JSON.stringify(results));`;
    const { stdout, stderr } = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: CHILD_TIME_LIMIT_MS });
    const results = JSON.parse(stdout);

    assert.equal(stderr, '');
    assert.deepEqual(results.map((result) => result.end), [{ kind: 'threw', name: 'Error', message: 'm', frames: [] }, { kind: 'threw', name: 'RangeError', message: 'x', frames: [] }]);
    for (const result of results) assert.deepEqual(result.names, result.before);
  });

  it("leaves the script's global object with the own names it held before the read, and gives no frame for a global that holds the read's name", async () => {
    const realms = [];
    const answerCall = ({ opts }) => {
      realms.push(opts);
      return 'ok';
    };
    const frames = await readFrames("\nawait agent('p', { scriptGlobal: globalThis, before: Object.getOwnPropertyNames(globalThis) })\nthrow new Error('x')", { answerCall });
    const heldFrames = await readFrames("\nglobalThis.__dwfb_readCallSites = 1\nawait agent('p', { scriptGlobal: globalThis })\nthrow new Error('x')", { answerCall });
    const [read, held] = realms;

    assert.deepEqual(frames, [{ line: 5, column: 7 }]);
    assert.deepEqual(Object.getOwnPropertyNames(read.scriptGlobal), [...read.before]);
    assert.deepEqual(heldFrames, []);
    assert.equal(held.scriptGlobal.__dwfb_readCallSites, 1);
  });

  it('keeps the frames when a trap of a Proxy the script made its Error throws as the hook is taken away', async () => {
    assert.deepEqual(await readFrames("\nglobalThis.Error = new Proxy(Error, { deleteProperty() { throw 1 } })\nthrow new RangeError('x')"), [{ line: 5, column: 7 }]);
  });

  it("hands the script's code a hook and descriptors whose Function refuses code from strings", async () => {
    const seenLists = [];
    const answerCall = ({ opts }) => {
      seenLists.push(opts.seen);
      return 'ok';
    };
    const tryFunction = "try { seen.push(String(VALUE.constructor('return 1')())) } catch (error) { seen.push(error.name) }";
    const fromGetter = tryFunction.replace('VALUE', 'Error.prepareStackTrace');
    const fromTrap = tryFunction.replace('VALUE', 'descriptor.constructor');
    const handOver = "const seen = []\nawait agent('p', { seen })";
    const getterFrames = await readFrames(`\n${handOver}\nthrow { message: 'm', get stack() { ${fromGetter}; return '' } }`, { answerCall });
    const trapFrames = await readFrames(`\n${handOver}\nglobalThis.Error = new Proxy(Error, { defineProperty(target, key, descriptor) { ${fromTrap}; return Reflect.defineProperty(target, key, descriptor) } })\nthrow new RangeError('x')`, { answerCall });

    assert.deepEqual(getterFrames, []);
    assert.deepEqual(trapFrames, [{ line: 7, column: 7 }]);
    assert.deepEqual(seenLists.map((seen) => [...seen]), [['EvalError'], ['EvalError']]);
  });

  it('records no log line, phase, group or call that code of the script run by the read makes, in a microtask it queues either', async () => {
    let callCount = 0;
    const answerCall = () => {
      callCount += 1;
      return 'ok';
    };
    const record = "log('read'); phase('p'); agent('p'); parallel([]); Promise.resolve().then(() => log('later'))";
    const proxyText = `\nglobalThis.Error = new Proxy(Error, { get(target, key, receiver) { ${record}; return Reflect.get(target, key, receiver) }, getOwnPropertyDescriptor(target, key) { ${record}; return Reflect.getOwnPropertyDescriptor(target, key) } })\nthrow new RangeError('x')`;
    const getterText = `\nthrow { message: 'm', get stack() { ${record}; return '' } }`;
    const traces = [await runSimulation(`${TALL_META}${proxyText}`, { answerCall }), await runSimulation(`${TALL_META}${getterText}`, { answerCall })];

    assert.deepEqual(traces.map((trace) => trace.end.frames), [[{ line: 5, column: 7 }], []]);
    for (const trace of traces) {
      assert.deepEqual([trace.logs, trace.phases, trace.groups, trace.events], [[], [], [], []]);
    }
    assert.equal(callCount, 0);
  });

  it('records a log line of a microtask that a message getter of the thrown value queues, since the name and the message are read first', async () => {
    const trace = await runSimulation(`${TALL_META}\nthrow { get message() { Promise.resolve().then(() => log('message')); return 'm' } }`, { answerCall: () => 'ok' });

    assert.deepEqual(trace.logs, ['message']);
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

    assert.deepEqual(end, { kind: 'threw', name: 'EvalError', message: 'Code generation from strings disallowed for this context', frames: [{ line: 2, column: 8 }] });
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

  it('adds spentPerCall to spent for each call that resolved to an answer, and none for a call that rejected', async () => {
    const cycle = {};
    cycle.self = cycle;
    const answerCall = (call) => {
      if (call.prompt === 'fail') throw new Error('no answer');
      return call.prompt === 'cycle' ? cycle : null;
    };
    const body = [
      "const spentList = [budget.spent(), await agent('one'), budget.spent()]",
      "await agent('fail').catch(() => null)",
      "await agent('cycle').catch(() => null)",
      "await agent('bad schema', { schema: { type: 'array' } }).catch(() => null)",
      "await agent('two')",
      'return [...spentList, budget.spent(), budget.remaining()]',
    ].join('\n');

    assert.deepEqual((await simulateBody(body, { answerCall, budget: { total: 100, spent: 5, spentPerCall: 20 } })).end.value, [5, null, 25, 45, 55]);
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
    assert.deepEqual(result, { end: { kind: 'returned', value: { value: 'early' } }, logs: [], phases: [], groups: [], events: [{ kind: 'call', index: 0 }] });
  });

  it('rejects options it cannot pass to the script, and a script the runtime refuses', async () => {
    await assert.rejects(runSimulation(`${META}return 1`, {}), { name: 'TypeError', message: /answerCall/ });
    await assert.rejects(simulateBody('return 1', { args: () => 1 }), { name: 'TypeError', message: /options\.args/ });
    await assert.rejects(simulateBody('return 1', { args: { count: 1n } }), { name: 'TypeError', message: /options\.args.*BigInt/ });
    await assert.rejects(simulateBody('return 1', { budget: 5 }), { name: 'TypeError', message: /options\.budget must/ });
    for (const total of ['5', -1, Number.NaN]) {
      await assert.rejects(simulateBody('return 1', { budget: { total } }), { name: 'TypeError', message: 'options.budget.total must be null or a number of 0 or more' });
    }
    for (const spent of ['5', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(simulateBody('return 1', { budget: { spent } }), { name: 'TypeError', message: 'options.budget.spent must be a finite number of 0 or more' });
    }
    for (const spentPerCall of ['5', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(simulateBody('return 1', { budget: { spentPerCall } }), { name: 'TypeError', message: /budget\.spentPerCall must be a finite number of 0 or more/ });
    }
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

    assert.deepEqual(stopped.end, { kind: 'threw', name: 'Error', message: `Script execution timed out after ${SCRIPT_TIME_LIMIT_MS}ms`, frames: [] });
    assert.deepEqual(awaited.end, { kind: 'returned', value: true });
  });
});

describe('a script that can never continue', () => {
  it('ends as never-settles, and an unhandled rejection before it ends nothing', async () => {
    const { end } = await simulateBody("Promise.reject(new Error('unhandled'))\nawait new Promise(() => {})");

    assert.deepEqual(end, { kind: 'never-settles' });
  });
});

describe('the order of an answer', () => {
  it('settles each agent() call after the microtasks the script queued in the turn of the call', async () => {
    const flag = await simulateBody("let answered = false\nagent('x').then(() => { answered = true; log('answered') })\nawait null\nlog('after one microtask')\nreturn answered", { answerCall: () => 'x' });
    const order = await simulateBody("const o = []\nconst p = agent('x').then(() => o.push('agent'))\nPromise.resolve().then(() => o.push('micro'))\nawait p\nreturn o", { answerCall: () => 'x' });

    assert.deepEqual([flag.end, flag.logs], [{ kind: 'returned', value: false }, ['after one microtask']]);
    assert.deepEqual(order.end, { kind: 'returned', value: ['micro', 'agent'] });
  });

  it('rejects a call whose answerCall throws after the microtasks the script queued in the turn of the call', async () => {
    const answerCall = () => {
      throw new Error('no answer');
    };
    const { end } = await simulateBody("const o = []\nconst p = agent('x').catch((error) => o.push(error.message))\nPromise.resolve().then(() => o.push('micro'))\nawait p\nreturn o", { answerCall });

    assert.deepEqual(end, { kind: 'returned', value: ['micro', 'no answer'] });
  });

  it('settles a call whose answerCall gives a promise in a turn after the promise settles', async () => {
    const body = "let answered = false\nagent('x').then(() => { answered = true }, () => { answered = true })\nawait null\nawait null\nawait null\nreturn answered";
    const fulfilled = await simulateBody(body, { answerCall: () => Promise.resolve('x') });
    const rejected = await simulateBody(body, { answerCall: () => Promise.reject(new Error('no answer')) });

    assert.deepEqual(fulfilled.end, { kind: 'returned', value: false });
    assert.deepEqual(rejected.end, { kind: 'returned', value: false });
  });

  it('settles the answers in call order, before any timer', async () => {
    const body = [
      'const o = []',
      "setTimeout(() => o.push('timer'), 0)",
      "await Promise.all([agent('one').then((value) => o.push(value)), agent('two').then((value) => o.push(value))])",
      'return o',
    ].join('\n');
    const { end } = await simulateBody(body, { answerCall: (call) => call.prompt });

    assert.deepEqual(end, { kind: 'returned', value: ['one', 'two'] });
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
    assert.deepEqual(result.groups, [
      { kind: 'parallel', items: 4, stages: 1, parent: null, beforeCall: 1 },
      { kind: 'pipeline', items: 2, stages: 2, parent: null, beforeCall: 5 },
    ]);
    assert.deepEqual(result.phases, [{ title: 'One', beforeCall: 0 }, { title: '2', beforeCall: 5 }]);
  });

  it('gives a call String of its phase option, or the latest phase() for options that are not an object and for an option that reading or String throws for', async () => {
    const phases = [];
    const answerCall = (call) => {
      phases.push(call.phase);
      return 'x';
    };
    const body = [
      "await agent('none')",
      "await agent('option', { phase: 'Own' })",
      "phase('Base')",
      "await agent('not an object', 'Own')",
      "await agent('symbol', { phase: Symbol('Own') })",
      "await agent('throwing String', { phase: { toString() { throw new Error('no text') } } })",
      "await agent('throwing read', { get phase() { throw new Error('no read') } })",
      "await agent('null', { phase: null })",
    ].join('\n');
    const { end } = await simulateBody(body, { answerCall });

    assert.deepEqual(end, { kind: 'returned', value: null });
    assert.deepEqual(phases, [null, 'Own', 'Base', 'Symbol(Own)', 'Base', 'Base', 'Base']);
  });
});

describe('answers', () => {
  it('gives the script a copy of each answer, made of objects of its realm', async () => {
    const shared = { items: [1] };
    const body = "const first = await agent('a')\nfirst.items.push(2)\nconst second = await agent('b')\nreturn [Object.getPrototypeOf(first) === Object.prototype, first.items instanceof Array, second.items]";
    const { end } = await simulateBody(body, { answerCall: () => shared });

    assert.deepEqual(end.value, [true, true, [1]]);
    assert.deepEqual(shared, { items: [1] });
  });

  it('rejects the call for an answer that holds a cycle', async () => {
    const cyclic = {};
    cyclic.self = cyclic;
    const { end } = await simulateBody("try { await agent('a') } catch (error) { return error.message }", { answerCall: () => cyclic });

    assert.deepEqual(end, { kind: 'returned', value: 'Maximum call stack size exceeded.' });
  });
});

describe('a stop', () => {
  it('ends the simulation at the call whose answerCall throws a SimulationStop, which the script cannot catch', async () => {
    let callCount = 0;
    const answerCall = () => {
      callCount += 1;
      throw new SimulationStop();
    };
    const body = "log('before')\ntry { await agent('a') } catch { log('caught') }\nagent('b')\nreturn 'after'";
    const result = await simulateBody(body, { answerCall });

    assert.deepEqual(result, { end: { kind: 'stopped' }, logs: ['before'], phases: [], groups: [], events: [{ kind: 'log', index: 0 }, { kind: 'call', index: 0 }] });
    assert.equal(callCount, 1);
  });

  it('ends the simulation for a SimulationStop that an answer rejects with, and before a return that follows it', async () => {
    const rejected = await simulateBody("await agent('a')", { answerCall: () => Promise.reject(new SimulationStop()) });
    const returned = await simulateBody("agent('a')\nreturn 'done'", { answerCall: () => { throw new SimulationStop(); } });

    assert.deepEqual(rejected.end, { kind: 'stopped' });
    assert.deepEqual(returned.end, { kind: 'stopped' });
  });

  it('ends the simulation as stopped when code after the stop runs past the time limit', async () => {
    const { end } = await simulateBody("agent('a')\nwhile (true) {}", { answerCall: () => { throw new SimulationStop(); } }, 5);

    assert.deepEqual(end, { kind: 'stopped' });
  });

  it('ends nothing once the script has settled, at a call that a microtask queued before the return makes', async () => {
    const answerCall = (call) => {
      if (call.prompt === 'late') throw new SimulationStop();
      return 'first';
    };
    const bodies = [
      "Promise.resolve().then(() => agent('late'))\nreturn 'done'",
      "Promise.resolve().then(() => null).then(() => null).then(() => agent('late'))\nreturn 'done'",
      "await agent('first')\nPromise.resolve().then(() => agent('late'))\nreturn 'done'",
    ];

    for (const body of bodies) {
      assert.deepEqual((await simulateBody(body, { answerCall })).end, { kind: 'returned', value: 'done' }, body);
    }
  });
});

describe('missing global names', () => {
  it('lists each runtime global name that neither the running Node nor the stand-in defines', () => {
    const nodeNames = new Set(runInContext('Object.getOwnPropertyNames(globalThis)', createContext({})));
    const expected = RUNTIME_GLOBAL_NAMES.filter((name) => !nodeNames.has(name) && !STAND_IN_NAMES.includes(name));

    assert.deepEqual(listMissingGlobalNames(), expected);
  });
});
