import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { simulate } from 'dynamic-workflow-bundler';
import { createInspection } from '../src/create-inspection.js';
import { findSimulateFixture } from './support/find-simulate-fixture.js';

const RUNTIME_FIXTURES = new URL('./fixtures/runtime/', import.meta.url);
const META = "export const meta = { name: 'p', description: 'd' }\n";
// The probes fail every call's argument check, so the runtime starts no agent. A trace holds no call that
// fails the check, so the test passes it with a schema object.
const FAILING_SCHEMA = 'schema: []';
const PASSING_SCHEMA = "schema: { type: 'object' }";
const PROGRESS_KEYS = ['type', 'index', 'title', 'phaseIndex', 'phaseTitle'];
const EVENT_LISTS = { call: 'calls', phase: 'phases', log: 'logs' };

const temporaryFolders = [];
after(async () => {
  for (const folder of temporaryFolders) await rm(folder, { recursive: true, force: true });
});

/**
 * @param {string} name
 * @param {string} text The entire script.
 * @returns {Promise<string>} The path of a new script in a new folder.
 */
async function writeScript(name, text) {
  const folder = await mkdtemp(join(tmpdir(), 'dwfb-trace-events-'));
  const script = join(folder, name);

  temporaryFolders.push(folder);
  await writeFile(script, text);
  return script;
}

/**
 * Checks that each element of `calls`, `phases` and `logs` has one event, that the events of one kind hold
 * the indexes 0, 1, 2 and so on in order, and that each phase's beforeCall counts the call events before it.
 * @param {import('../src/simulate.js').Trace} trace
 */
function checkEvents(trace) {
  const callEventCounts = [];
  let callEventCount = 0;

  for (const [kind, list] of Object.entries(EVENT_LISTS)) {
    const indexes = trace.events.filter((event) => event.kind === kind).map((event) => event.index);

    assert.deepEqual(indexes, [...trace[list].keys()], kind);
  }
  assert.equal(trace.events.length, trace.calls.length + trace.phases.length + trace.logs.length);
  for (const event of trace.events) {
    if (event.kind === 'call') callEventCount += 1;
    if (event.kind === 'phase') callEventCounts.push(callEventCount);
  }
  assert.deepEqual(trace.phases.map((phase) => phase.beforeCall), callEventCounts);
}

/**
 * Derives the progress list the runtime reports from a trace: a phase entry the first time a title appears,
 * from a phase() invocation or a call's phase, and a call entry with the index of its phase's title.
 * @param {import('../src/simulate.js').Trace} trace
 * @returns {object[]}
 */
function deriveProgress(trace) {
  const progress = [];
  const titleIndexes = new Map();
  const addTitle = (title) => {
    if (title === null || titleIndexes.has(title)) return;
    titleIndexes.set(title, titleIndexes.size + 1);
    progress.push({ type: 'phase', index: titleIndexes.size, title });
  };

  for (const event of trace.events) {
    if (event.kind === 'phase') addTitle(trace.phases[event.index].title);
    if (event.kind !== 'call') continue;
    const { phase } = trace.calls[event.index];
    addTitle(phase);
    progress.push({ type: 'call', index: event.index + 1, phaseIndex: phase === null ? null : titleIndexes.get(phase), phaseTitle: phase });
  }
  return progress;
}

/**
 * @param {object} entry
 * @returns {object} The entry with only the keys of PROGRESS_KEYS that it holds.
 */
function pickProgressKeys(entry) {
  return Object.fromEntries(PROGRESS_KEYS.filter((key) => Object.hasOwn(entry, key)).map((key) => [key, entry[key]]));
}

const measured = JSON.parse(await readFile(new URL('phase-probe.measured.json', RUNTIME_FIXTURES), 'utf8'));
const PROBES = [
  { probe: 'phase-probe-order', key: 'order' },
  { probe: 'phase-probe-values', key: 'values' },
];

for (const { probe, key } of PROBES) {
  describe(`${probe}.js, as Claude Code 2.1.332 ran it`, () => {
    const { progress } = measured[key];
    const measuredCalls = progress.filter((entry) => entry.type === 'call');
    let simulation = null;
    const simulateProbe = () => (simulation ??= (async () => {
      const text = await readFile(new URL(`${probe}.js`, RUNTIME_FIXTURES), 'utf8');
      const script = await writeScript(`${probe}.js`, text.replaceAll(FAILING_SCHEMA, PASSING_SCHEMA));

      return simulate({ script, scenario: { respond: { '': {} } } });
    })());

    it("gives each call the runtime's phase", async () => {
      const trace = await simulateProbe();

      assert.equal(trace.end.kind, 'returned');
      assert.equal(trace.calls.length, measuredCalls.length);
      for (const call of trace.calls) assert.equal(call.phase, measuredCalls.find((entry) => entry.index === call.index + 1).phaseTitle, `call ${call.index}`);
    });

    it("lists events from which the runtime's progress list follows", async () => {
      const trace = await simulateProbe();

      assert.deepEqual(deriveProgress(trace), progress.map(pickProgressKeys));
      checkEvents(trace);
    });

    it('gives an inspection whose call events, in order, are the calls of the trace', async () => {
      const trace = await simulateProbe();
      const callEvents = createInspection(trace).events.filter((event) => event.kind === 'call');
      const pickCallKeys = ({ index, label, phase }) => ({ index, label, phase });

      assert.deepEqual(callEvents.map(pickCallKeys), trace.calls.map(pickCallKeys));
    });
  });
}

describe('the order of events', () => {
  it('lists each call where the script invoked agent(), and each phase() and log line where the script made it', async () => {
    const body = [
      "log('first')",
      "phase('Build')",
      "await agent('one', { label: 'one' })",
      "console.log('second')",
      "const pending = agent('two', { label: 'two' })",
      "log('third')",
      'await pending',
      'await parallel([',
      "  async () => { phase('Fan'); return agent('a', { label: 'a' }) },",
      "  () => agent('b', { label: 'b' }),",
      '])',
      "await pipeline(['x'], (item) => item, () => agent('stage', { label: 'stage' }))",
      "return 'done'",
    ].join('\n');
    const trace = await simulate({ script: await writeScript('order.js', `${META}${body}\n`), scenario: { respond: { '': 'any' } } });

    assert.deepEqual(trace.end, { kind: 'returned', value: 'done' });
    assert.deepEqual(trace.events, [
      { kind: 'log', index: 0 },
      { kind: 'phase', index: 0 },
      { kind: 'call', index: 0 },
      { kind: 'log', index: 1 },
      { kind: 'call', index: 1 },
      { kind: 'log', index: 2 },
      { kind: 'phase', index: 1 },
      { kind: 'call', index: 2 },
      { kind: 'call', index: 3 },
      { kind: 'call', index: 4 },
    ]);
    assert.deepEqual(trace.calls.map((call) => [call.label, call.phase, call.group?.stage ?? null]), [
      ['one', 'Build', null],
      ['two', 'Build', null],
      ['a', 'Fan', 0],
      ['b', 'Fan', 0],
      ['stage', 'Fan', 1],
    ]);
    assert.deepEqual(trace.logs, ['first', 'second', 'third']);
    checkEvents(trace);
  });

  it('lists the event of the call a simulation stopped at', async () => {
    const body = "phase('Answer')\nawait agent('one', { label: 'one' })\nlog('between')\nawait agent('two', { label: 'two' })\nreturn 'done'";
    const trace = await simulate({ script: await writeScript('stopped.js', `${META}${body}\n`), scenario: { respond: { one: 'x' } } });

    assert.deepEqual([trace.end.kind, trace.end.reason, trace.end.call], ['stopped', 'unanswered', 1]);
    assert.deepEqual(trace.calls.map((call) => [call.label, call.phase]), [['one', 'Answer'], ['two', 'Answer']]);
    assert.deepEqual(trace.events, [
      { kind: 'phase', index: 0 },
      { kind: 'call', index: 0 },
      { kind: 'log', index: 0 },
      { kind: 'call', index: 1 },
    ]);
    checkEvents(trace);
  });

  it('lists no event of a call the trace drops, and counts no such call in beforeCall', async () => {
    const body = "Promise.resolve().then(() => { agent('Late', { label: 'late' }); phase('After') })\nreturn 'done'";
    const trace = await simulate({ script: await writeScript('late.js', `${META}${body}\n`) });

    assert.deepEqual([trace.end, trace.calls], [{ kind: 'returned', value: 'done' }, []]);
    assert.deepEqual([trace.phases, trace.events], [[{ title: 'After', beforeCall: 0 }], [{ kind: 'phase', index: 0 }]]);
    checkEvents(trace);
  });

  it('lists no event of a call rejected for options the simulation cannot read', async () => {
    const body = [
      "phase('One')",
      "try { await agent('bad', { get label() { throw new Error('no label') } }) } catch (error) { log(`caught ${error.message}`) }",
      "phase('Two')",
      "await agent('good', { label: 'good' })",
      "return 'done'",
    ].join('\n');
    const trace = await simulate({ script: await writeScript('rejected.js', `${META}${body}\n`), scenario: { respond: { '': 'any' } } });

    assert.deepEqual(trace.end, { kind: 'returned', value: 'done' });
    assert.deepEqual([trace.calls.map((call) => call.label), trace.logs], [['good'], ['caught no label']]);
    assert.deepEqual([trace.phases, trace.events], [
      [{ title: 'One', beforeCall: 0 }, { title: 'Two', beforeCall: 0 }],
      [{ kind: 'phase', index: 0 }, { kind: 'log', index: 0 }, { kind: 'phase', index: 1 }, { kind: 'call', index: 0 }],
    ]);
    checkEvents(trace);
  });

  it('lists no event for a script that did not run', async () => {
    const script = findSimulateFixture('no-meta');
    const trace = await simulate({ script });

    assert.equal(trace.end.kind, 'refused');
    assert.deepEqual(trace.events, []);
    checkEvents(trace);
  });
});
