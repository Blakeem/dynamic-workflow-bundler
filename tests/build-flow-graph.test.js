import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFlowGraph } from '../src/build-flow-graph.js';

const DONE = { kind: 'returned', value: { status: 'done' } };
const SEQ_ROLES = ['dev', 'check'];
const SEQ_SITES = [
  { line: 12, column: 31, template: 'No block to build', isMessageBuilt: false },
  { line: 20, column: 34, template: 'Dead in round .... Resume with the same args.', isMessageBuilt: true },
];
// The labels of the seq script's scenario in which each check passes in round 2.
const SEQ_ROUND_2_LABELS = ['dev a r1', 'check a r1', 'dev a r2', 'check a r2', 'dev b r1', 'check b r1', 'dev b r2', 'check b r2'];

/**
 * @typedef {string | { label: string | null, group?: [number, number], phase?: string | null, model?: unknown }} CallSpec
 *   A label alone, or a call with its group as [group, item].
 */

/**
 * @param {string} name
 * @param {CallSpec[]} callSpecs
 * @param {unknown} [end]
 * @param {{ when?: string, endState?: string, beforeCalls?: number[], parents?: ([number, number] | null)[] }} [scenario]
 *   `beforeCalls` gives the beforeCall of each group, by index. Each group missing from it starts at its first call,
 *   or after the last call. `parents` gives the lane that started each group as [group, item]. Each group missing
 *   from it has the parent null.
 * @returns {import('../src/build-flow-graph.js').FlowSimulation}
 */
function createSimulation(name, callSpecs, end = DONE, scenario = {}) {
  const calls = callSpecs.map((spec, index) => {
    const { label, group, phase = null, model } = typeof spec === 'string' ? { label: spec } : spec;

    return {
      index,
      label,
      prompt: '',
      opts: model === undefined ? { label } : { label, model },
      group: group === undefined ? null : { group: group[0], item: group[1], stage: 0 },
      phase,
    };
  });
  const groupCount = Math.max(scenario.beforeCalls?.length ?? 0, ...calls.map((call) => (call.group === null ? 0 : call.group.group + 1)));
  const groups = Array.from({ length: groupCount }, (_, groupIndex) => {
    const groupCalls = calls.filter((call) => call.group?.group === groupIndex);
    const firstCall = groupCalls.length === 0 ? calls.length : groupCalls[0].index;
    const items = Math.max(0, ...groupCalls.map((call) => call.group.item + 1));
    const parentLane = scenario.parents?.[groupIndex] ?? null;
    const parent = parentLane === null ? null : { group: parentLane[0], item: parentLane[1], stage: 0 };

    return { kind: 'parallel', items, stages: 1, parent, beforeCall: scenario.beforeCalls?.[groupIndex] ?? firstCall };
  });
  const trace = { script: 's.js', scenario: name, runtime: '2.1.332', end, calls, groups, phases: [], logs: [], events: [] };

  return { name, when: scenario.when ?? name, endState: scenario.endState ?? null, trace };
}

/**
 * @param {import('../src/build-flow-graph.js').FlowSimulation[]} simulations
 * @param {{ roles: string[], throwSites?: import('../src/read-throw-sites.js').ThrowSite[], phases?: unknown[] }} script
 * @returns {import('../src/build-flow-graph.js').FlowGraph}
 */
function buildGraph(simulations, { roles, throwSites = [], phases = [] }) {
  const { graph, unmapped } = buildFlowGraph({ roles, throwSites, phases, runs: simulations });

  assert.deepEqual(unmapped, []);
  return /** @type {import('../src/build-flow-graph.js').FlowGraph} */ (graph);
}

/**
 * @param {import('../src/build-flow-graph.js').FlowSimulation[]} simulations
 * @param {{ roles: string[], throwSites?: import('../src/read-throw-sites.js').ThrowSite[] }} script
 * @returns {import('../src/build-flow-graph.js').UnmappedScenario[]}
 */
function findUnmapped(simulations, { roles, throwSites = [] }) {
  const { graph, unmapped } = buildFlowGraph({ roles, throwSites, phases: [], runs: simulations });

  assert.equal(graph, null);
  return unmapped;
}

/**
 * @param {import('../src/build-flow-graph.js').FlowGraph} graph
 * @returns {string[]} Each edge as `<from> <kind> <to> <repeat>`, where kind is `->`, `-back->` or `=next=>`.
 */
function listEdges(graph) {
  return graph.edges.map((edge) => `${edge.from} ${edge.back ? '-back->' : edge.nextItem ? '=next=>' : '->'} ${edge.to} ${edge.repeat}`);
}

/**
 * @param {string} message
 * @param {{ line: number, column: number }[]} frames
 * @param {string} [name]
 * @returns {{ kind: 'threw', name: string, message: string, frames: { line: number, column: number }[] }}
 */
function createThrewEnd(message, frames, name = 'Error') {
  return { kind: 'threw', name, message, frames };
}

/**
 * @param {string} template A throw site's template.
 * @param {boolean} [isMessageBuilt] The site's isMessageBuilt.
 * @returns {string} The label of the throw node that an error the site creates reaches.
 */
function readThrowLabel(template, isMessageBuilt = false) {
  const site = { line: 3, column: 7, template, isMessageBuilt };
  const graph = buildGraph([createSimulation('a', [], createThrewEnd(template, [{ line: 3, column: 7 }]))], { roles: [], throwSites: [site] });

  return graph.nodes[0].label;
}

describe('buildFlowGraph', () => {
  it('gives a simulation that returned the status of its returned object as its end state, else the scenario endState', () => {
    const graph = buildGraph(
      [
        createSimulation('status', [], DONE, { endState: 'done' }),
        createSimulation('declared', [], { kind: 'returned', value: {} }, { endState: 'written' }),
        createSimulation('number status', [], { kind: 'returned', value: { status: 5 } }, { endState: 'counted' }),
        createSimulation('empty status', [], { kind: 'returned', value: { status: '' } }, { endState: 'written' }),
        createSimulation('not an object', [], { kind: 'returned', value: 'done' }, { endState: 'text' }),
      ],
      { roles: [] },
    );

    assert.deepEqual(
      graph.nodes.map(({ id, label, source, scenarios }) => ({ id, label, source, scenarios })),
      [
        { id: 't1', label: 'done', source: 'returned', scenarios: ['status'] },
        { id: 't2', label: 'written', source: 'scenario', scenarios: ['declared', 'empty status'] },
        { id: 't3', label: 'counted', source: 'scenario', scenarios: ['number status'] },
        { id: 't4', label: 'text', source: 'scenario', scenarios: ['not an object'] },
      ],
    );
  });

  it('leaves unmapped a simulation whose endState differs from its status, and one with neither', () => {
    const unmapped = findUnmapped(
      [
        createSimulation('differs', [], DONE, { endState: 'finished' }),
        createSimulation('neither', [], { kind: 'returned', value: null }),
        createSimulation('number status', [], { kind: 'returned', value: { status: 5 } }),
        createSimulation('same after digits', [], { kind: 'returned', value: { status: 'done 2' } }, { endState: 'done 3' }),
      ],
      { roles: [] },
    );

    assert.deepEqual(unmapped, [
      { scenario: 'differs', reason: 'the script returned the status "done", which differs from the scenario\'s endState "finished"' },
      { scenario: 'neither', reason: 'the script returned no status that is a non-empty string, and the scenario names no endState' },
      { scenario: 'number status', reason: 'the script returned no status that is a non-empty string, and the scenario names no endState' },
    ]);
  });

  it('gives a simulation that threw the throw site at the line and column of its newest frame, whatever the message', () => {
    const sites = [
      { line: 4, column: 7, template: 'Dead', isMessageBuilt: false },
      { line: 4, column: 30, template: 'Dead', isMessageBuilt: false },
      { line: 7, column: 7, template: 'Dead in round ...', isMessageBuilt: true },
      { line: 9, column: 7, template: 'Wrong type', isMessageBuilt: false },
    ];
    const graph = buildGraph(
      [
        createSimulation('round', [], createThrewEnd('Dead in round 2', [{ line: 7, column: 7 }, { line: 4, column: 30 }])),
        createSimulation('second', [], createThrewEnd('Dead', [{ line: 4, column: 30 }])),
        createSimulation('first', [], createThrewEnd('Dead', [{ line: 4, column: 7 }])),
        createSimulation('other text', [], createThrewEnd('Gone', [{ line: 7, column: 7 }], 'BlockError')),
        createSimulation('engine name', [], createThrewEnd('Bad', [{ line: 9, column: 7 }], 'TypeError')),
      ],
      { roles: [], throwSites: sites },
    );

    assert.deepEqual(
      graph.nodes.map(({ id, line, scenarios }) => ({ id, line, scenarios })),
      [
        { id: 'x1', line: 4, scenarios: ['first'] },
        { id: 'x2', line: 4, scenarios: ['second'] },
        { id: 'x3', line: 7, scenarios: ['round', 'other text'] },
        { id: 'x4', line: 9, scenarios: ['engine name'] },
      ],
    );
  });

  it('ends an error of each engine error name at the throw site of its newest frame', () => {
    const names = ['EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError'];
    const sites = [{ line: 3, column: 7, template: 'boom', isMessageBuilt: false }];
    const graph = buildGraph(
      names.map((name) => createSimulation(name, [], createThrewEnd('Fail is not a constructor', [{ line: 3, column: 7 }], name))),
      { roles: [], throwSites: sites },
    );

    assert.deepEqual(
      graph.nodes.map(({ id, label, line, scenarios }) => ({ id, label, line, scenarios })),
      [{ id: 'x1', label: 'throw: boom', line: 3, scenarios: names }],
    );
  });

  it('ends at each of three throw sites a TypeError that the site raises while it creates its error', () => {
    const sites = [
      { line: 3, column: 7, template: 'x', isMessageBuilt: false },
      { line: 4, column: 7, template: '', isMessageBuilt: true },
      { line: 5, column: 7, template: '', isMessageBuilt: true },
    ];
    const graph = buildGraph(
      [
        createSimulation('binding', [], createThrewEnd('TypeError is not a constructor', [{ line: 3, column: 7 }], 'TypeError')),
        createSimulation('spread', [], createThrewEnd('args.parts is not iterable', [{ line: 4, column: 7 }], 'TypeError')),
        createSimulation('other global', [], createThrewEnd('Cannot convert a Symbol value to a string', [{ line: 5, column: 7 }], 'TypeError')),
      ],
      { roles: [], throwSites: sites },
    );

    assert.deepEqual(
      graph.nodes.map(({ id, line, scenarios }) => ({ id, line, scenarios })),
      [
        { id: 'x1', line: 3, scenarios: ['binding'] },
        { id: 'x2', line: 4, scenarios: ['spread'] },
        { id: 'x3', line: 5, scenarios: ['other global'] },
      ],
    );
  });

  it('folds the throws of the seq script in rounds 1 and 3 into one throw node', () => {
    const labels = ['dev a r1', 'check a r1', 'dev b r1', 'check b r1'];
    const graph = buildGraph(
      [
        createSimulation('dies in round 1', labels, createThrewEnd('Dead in round 1. Resume with the same args.', [{ line: 20, column: 34 }])),
        createSimulation('dies in round 3', labels, createThrewEnd('Dead in round 3. Resume with the same args.', [{ line: 20, column: 34 }])),
      ],
      { roles: SEQ_ROLES, throwSites: SEQ_SITES },
    );

    assert.deepEqual(graph.nodes[2], {
      id: 'x1',
      kind: 'throw',
      label: 'throw: Dead in round ...',
      source: 'throw',
      line: 20,
      scenarios: ['dies in round 1', 'dies in round 3'],
      whens: ['dies in round 1', 'dies in round 3'],
    });
  });

  it('leaves unmapped a throw with no frame, and one whose newest frame is no throw site though an older frame is', () => {
    const unmapped = findUnmapped(
      [
        createSimulation('no frame', [], createThrewEnd('Gone\n', [], 'Bad\tError')),
        createSimulation('older frame', [], createThrewEnd('No block to build', [{ line: 2, column: 5 }, { line: 12, column: 31 }])),
        createSimulation('other column', [], createThrewEnd('No block to build', [{ line: 12, column: 30 }])),
      ],
      { roles: [], throwSites: SEQ_SITES },
    );

    assert.deepEqual(unmapped, [
      { scenario: 'no frame', reason: 'the script threw Bad\\u{0009}Error: Gone\\u{000A}, and the simulation recorded no place it was created at' },
      { scenario: 'older frame', reason: 'the script threw Error: No block to build at line 2, column 5, which is no throw site' },
      { scenario: 'other column', reason: 'the script threw Error: No block to build at line 12, column 30, which is no throw site' },
    ]);
  });

  it('makes each run of digits of an end state the letter N, for identity and for display', () => {
    const graph = buildGraph(
      [
        createSimulation('two', [], { kind: 'returned', value: { status: 'run complete (2 blocks)' } }),
        createSimulation('three', [], { kind: 'returned', value: { status: 'run complete (13 blocks)' } }, { endState: 'run complete (4 blocks)' }),
        createSimulation('declared', [], { kind: 'returned', value: {} }, { endState: 'inventory of 2 units written' }),
      ],
      { roles: [] },
    );

    assert.deepEqual(
      graph.nodes.map(({ label, scenarios }) => ({ label, scenarios })),
      [
        { label: 'run complete (N blocks)', scenarios: ['two', 'three'] },
        { label: 'inventory of N units written', scenarios: ['declared'] },
      ],
    );
  });

  it('gives a call the longest role its label starts with, and the item after the role and before a round marker', () => {
    const graph = buildGraph([createSimulation('a', ['develop-closing plan-a', 'develop plan-a r2', 'develop plan-b r1', 'curate:r1', 'curate:r2'])], {
      roles: ['develop', 'develop-closing', 'curate'],
    });

    assert.deepEqual(
      graph.nodes.filter((node) => node.kind === 'agent').map(({ id, role }) => ({ id, role })),
      [
        { id: 'a1', role: 'develop' },
        { id: 'a2', role: 'develop-closing' },
        { id: 'a3', role: 'curate' },
      ],
    );
    // The items plan-a and plan-b make a next-item edge, and curate:r1 and curate:r2 both have the item ''.
    assert.deepEqual(listEdges(graph), ['S0 -> a2 0', 'a1 =next=> a1 0', 'a1 -> a3 0', 'a2 -> a1 0', 'a3 -back-> a3 2', 'a3 -> t1 0']);
  });

  it('leaves unmapped a call with no label and a call whose label starts with no role, each with what to change', () => {
    const unmapped = findUnmapped([createSimulation('no label', ['dev a', { label: null }]), createSimulation('ghost', ['ghost-role'])], { roles: SEQ_ROLES });
    const noRole = findUnmapped([createSimulation('a', ['dev']), createSimulation('b', [{ label: null }])], { roles: [] });

    assert.deepEqual(unmapped, [
      { scenario: 'no label', reason: 'call 1 (no label) names no role of the script, whose roles are "dev", "check", so give the call a label that starts with a role' },
      { scenario: 'ghost', reason: 'call 0 (label "ghost-role") names no role of the script, whose roles are "dev", "check", so start the label with a role' },
    ]);
    assert.deepEqual(noRole, [
      { scenario: 'a', reason: 'call 0 (label "dev") names no role of the script, which has no role, so start the label with a role' },
      { scenario: 'b', reason: 'call 0 (no label) names no role of the script, which has no role, so give the call a label that starts with a role' },
    ]);
  });

  it('gives an agent node the phase and model of its first call, and the most lanes that held a call of its role at once', () => {
    const fanCalls = [
      { label: 'review:u1/x', group: [0, 0], phase: 'Review', model: 'sonnet' },
      { label: 'review:u2/x', group: [0, 1], phase: 'Review', model: 'sonnet' },
      { label: 'review:u1/y', group: [0, 0], phase: 'Review', model: 'sonnet' },
      { label: 'review:u2/y', group: [0, 1], phase: 'Review', model: 'sonnet' },
      { label: 'verify:u1', group: [0, 0], phase: 'Verify', model: 'sonnet' },
      { label: 'verify:u2', group: [0, 1], phase: 'Verify', model: 'sonnet' },
    ];
    const graph = buildGraph(
      [
        createSimulation('first', [{ label: 'plan', phase: null, model: 5 }, ...fanCalls]),
        createSimulation('second', [{ label: 'plan', phase: 'Later', model: 'opus' }, { label: 'review:u1', group: [3, 0] }, { label: 'review:u2', group: [3, 1] }, { label: 'review:u3', group: [3, 2] }]),
      ],
      { roles: ['plan', 'review', 'verify'] },
    );

    assert.deepEqual(
      graph.nodes.filter((node) => node.kind === 'agent').map(({ role, phase, model, concurrency }) => ({ role, phase, model, concurrency })),
      [
        { role: 'plan', phase: '', model: '', concurrency: 1 },
        { role: 'review', phase: 'Review', model: 'sonnet', concurrency: 3 },
        { role: 'verify', phase: 'Verify', model: 'sonnet', concurrency: 2 },
      ],
    );
  });

  it('cuts a trace into segments of calls next to each other, with one lane per item of a group', () => {
    // The fixture of the rounds script: two lanes of work, one check, and the same again.
    const rounds = buildGraph(
      [
        createSimulation('two rounds', [
          { label: 'work:a', group: [0, 0] },
          { label: 'work:b', group: [0, 1] },
          'check:r1',
          { label: 'work:a', group: [1, 0] },
          { label: 'work:b', group: [1, 1] },
          'check:r2',
        ]),
      ],
      { roles: ['work', 'check'] },
    );
    // Item 1 calls first, and its lane still comes second, so the plain back edge of item 0 is made first.
    const laneOrder = buildGraph([createSimulation('a', [{ label: 'work:b', group: [0, 1] }, { label: 'work', group: [0, 0] }, 'work:c'])], { roles: ['work'] });

    assert.deepEqual(listEdges(rounds), ['S0 -> a1 0', 'a1 -> a2 0', 'a2 -back-> a1 2', 'a2 -> t1 0']);
    assert.deepEqual(listEdges(laneOrder), ['S0 -> a1 0', 'a1 -back-> a1 2', 'a1 =next=> a1 0', 'a1 -> t1 0']);
  });

  it('leaves unmapped a call that a context made after it started a group and before the last call of that group', () => {
    const reason = (context, call, group) => `${context} made ${call} before the last call made in group ${group}, which it started, so the flow map cannot place it`;
    const unmapped = findUnmapped(
      [
        createSimulation('split', [{ label: 'work:a', group: [0, 0] }, 'check', { label: 'work:b', group: [0, 1] }]),
        // Group 1 starts before call 0 and makes its one call at call 1, after the call of the top level.
        createSimulation('first call', ['check', { label: 'work:a', group: [1, 0] }], DONE, { beforeCalls: [2, 0] }),
      ],
      { roles: ['work', 'check'] },
    );
    // A call at the index of the group's last call cannot be the context's own, and a call after it is outside the group.
    const after = buildGraph([createSimulation('a', [{ label: 'work:a', group: [0, 0] }, 'check'], DONE, { beforeCalls: [0] })], { roles: ['work', 'check'] });

    assert.deepEqual(unmapped, [
      { scenario: 'split', reason: reason('the top level', 'call 1 (label "check")', 0) },
      { scenario: 'first call', reason: reason('the top level', 'call 0 (label "check")', 1) },
    ]);
    assert.deepEqual(listEdges(after), ['S0 -> a1 0', 'a1 -> a2 0', 'a2 -> t1 0']);
  });

  it('adds a group to a segment of groups when it ran at the same time as any group of the segment', () => {
    // Group 2 starts after the last call of group 1 and before the last call of group 0.
    const calls = [{ label: 'work:a', group: [0, 0] }, { label: 'scan', group: [1, 0] }, { label: 'probe', group: [2, 0] }, { label: 'work:b', group: [0, 1] }, 'report'];
    const graph = buildGraph([createSimulation('a', calls, DONE, { beforeCalls: [0, 1, 2] })], { roles: ['work', 'scan', 'probe', 'report'] });

    assert.deepEqual(listEdges(graph), ['S0 -> a1 0', 'S0 -> a2 0', 'S0 -> a3 0', 'a1 -> a4 0', 'a2 -> a4 0', 'a3 -> a4 0', 'a4 -> t1 0']);
    assert.deepEqual(graph.nodes.slice(0, 4).map((node) => node.concurrency), [2, 1, 1, 1]);
  });

  it('counts the calls of a group nested in a group when it adds a later group to their segment', () => {
    // Group 0 makes its own last call at call 0, and group 1, started in its lane, runs on past the start of group 2.
    const calls = [{ label: 'work', group: [0, 0] }, { label: 'scan', group: [1, 0] }, { label: 'probe', group: [2, 0] }, { label: 'merge', group: [1, 0] }, 'report'];
    const graph = buildGraph([createSimulation('a', calls, DONE, { beforeCalls: [0, 1, 2], parents: [null, [0, 0], null] })], { roles: ['work', 'scan', 'probe', 'merge', 'report'] });

    assert.deepEqual(listEdges(graph), ['S0 -> a1 0', 'S0 -> a3 0', 'a1 -> a2 0', 'a2 -> a4 0', 'a3 -> a5 0', 'a4 -> a5 0', 'a5 -> t1 0']);
  });

  it('leaves out a group in which no call was made', () => {
    // Group 0 starts between the two calls and makes no call, so plan joins check.
    const graph = buildGraph([createSimulation('a', ['plan', 'check'], DONE, { beforeCalls: [1] })], { roles: ['plan', 'check'] });

    assert.deepEqual(listEdges(graph), ['S0 -> a1 0', 'a1 -> a2 0', 'a2 -> t1 0']);
  });

  it('makes a next-item edge inside an ungrouped lane from one non-empty item to another, and none inside a group', () => {
    const seq = buildGraph([createSimulation('pass in round 1', ['dev a r1', 'check a r1', 'dev b r1', 'check b r1'])], { roles: SEQ_ROLES });
    const fan = buildGraph([createSimulation('a', [{ label: 'review:u1/x', group: [0, 0] }, { label: 'review:u1/y', group: [0, 0] }])], { roles: ['review'] });
    const emptyItem = buildGraph([createSimulation('a', ['dev a', 'dev', 'dev b'])], { roles: ['dev'] });

    // check a r1 to dev b r1 has the items a and b.
    assert.deepEqual(listEdges(seq), ['S0 -> a1 0', 'a1 -> a2 0', 'a2 =next=> a1 0', 'a2 -> t1 0']);
    assert.deepEqual(listEdges(fan), ['S0 -> a1 0', 'a1 -back-> a1 2', 'a1 -> t1 0']);
    // dev a to dev and dev to dev b each have one empty item, so both are back edges, of the lanes a and ''.
    assert.deepEqual(listEdges(emptyItem), ['S0 -> a1 0', 'a1 -back-> a1 2', 'a1 -> t1 0']);
  });

  it('joins each lane exit of a segment to each lane entry of the next, and the first segment to the start', () => {
    const fan = buildGraph([createSimulation('a', [{ label: 'review:u1/x', group: [0, 0] }, { label: 'review:u2/x', group: [0, 1] }])], { roles: ['review'] });
    const intoGroup = buildGraph([createSimulation('a', ['plan:a', { label: 'work:b', group: [0, 0] }, { label: 'work:a', group: [0, 1] }])], { roles: ['plan', 'work'] });
    const twoGroups = buildGraph([createSimulation('a', [{ label: 'work:a', group: [0, 0] }, { label: 'check:b', group: [1, 0] }])], { roles: ['work', 'check'] });

    // The two lane entries of the fan script merge into one edge from the start.
    assert.deepEqual(listEdges(fan), ['S0 -> a1 0', 'a1 -> t1 0']);
    assert.deepEqual(listEdges(intoGroup), ['S0 -> a1 0', 'a1 =next=> a2 0', 'a1 -> a2 0', 'a2 -> t1 0']);
    assert.deepEqual(listEdges(twoGroups), ['S0 -> a1 0', 'a1 -> a2 0', 'a2 -> t1 0']);
  });

  it('makes an edge a back edge when its target was reached before and first reached no later than its source', () => {
    const seq = buildGraph([createSimulation('pass in round 2', ['dev a r1', 'check a r1', 'dev a r2', 'check a r2'])], { roles: SEQ_ROLES });
    // In lane 1, p was reached only by lane 0 of the same segment, so q to p is no back edge.
    const lanes = buildGraph(
      [createSimulation('a', [{ label: 'p', group: [0, 0] }, { label: 'q', group: [0, 1] }, { label: 'q', group: [0, 0] }, { label: 'p', group: [0, 1] }])],
      { roles: ['p', 'q'] },
    );
    // The join from p into q, which the group before reached first, goes back.
    const join = buildGraph([createSimulation('a', [{ label: 'q', group: [0, 0] }, { label: 'p', group: [0, 0] }, 'q'])], { roles: ['p', 'q'] });

    // check a r1 to dev a r2 goes back, and dev a r2 to check a r2 goes forward.
    assert.deepEqual(listEdges(seq), ['S0 -> a1 0', 'a1 -> a2 0', 'a2 -back-> a1 2', 'a2 -> t1 0']);
    assert.deepEqual(listEdges(lanes), ['S0 -> a1 0', 'S0 -> a2 0', 'a1 -> a2 0', 'a1 -> t1 0', 'a2 -> a1 0', 'a2 -> t1 0']);
    assert.deepEqual(listEdges(join), ['S0 -> a2 0', 'a1 -back-> a2 2', 'a2 -> a1 0', 'a2 -> t1 0']);
  });

  it('gives a back edge one more than the most times one lane walks it in one scenario, over every scenario', () => {
    const seq = buildGraph([createSimulation('pass in round 2', SEQ_ROUND_2_LABELS)], { roles: SEQ_ROLES });
    const threeRounds = buildGraph(
      [createSimulation('two rounds', ['dev a r1', 'check a r1', 'dev a r2']), createSimulation('three rounds', ['dev a r1', 'check a r1', 'dev a r2', 'check a r2', 'dev a r3'])],
      { roles: SEQ_ROLES },
    );
    // One check enters two lanes, and the walk counts once for the pair of segments.
    const intoLanes = buildGraph(
      [createSimulation('a', [{ label: 'work:a', group: [0, 0] }, { label: 'work:b', group: [0, 1] }, 'check:r1', { label: 'work:a', group: [1, 0] }, { label: 'work:b', group: [1, 1] }])],
      { roles: ['work', 'check'] },
    );

    // Lanes a and b each walk check to dev once, so the edge reads 2 and not 3.
    assert.deepEqual(listEdges(seq), ['S0 -> a1 0', 'a1 -> a2 0', 'a2 -back-> a1 2', 'a2 =next=> a1 0', 'a2 -> t1 0']);
    assert.deepEqual(listEdges(threeRounds), ['S0 -> a1 0', 'a1 -> a2 0', 'a1 -> t1 0', 'a2 -back-> a1 3']);
    assert.equal(intoLanes.edges.find((edge) => edge.back).repeat, 2);
  });

  it('joins the exits of the last segment to the end state, and the start to it for a trace with no call', () => {
    const graph = buildGraph(
      [createSimulation('fan', [{ label: 'verify:u1', group: [0, 0] }, { label: 'verify:u2', group: [0, 1] }]), createSimulation('early', [], createThrewEnd('No block to build', [{ line: 12, column: 31 }]))],
      { roles: ['verify'], throwSites: SEQ_SITES },
    );

    assert.deepEqual(listEdges(graph), ['S0 -> a1 0', 'S0 -> x1 0', 'a1 -> t1 0']);
    assert.deepEqual(graph.edges[2].whens, ['fan']);
  });

  it('merges edges by source, target and next-item, with each when once, back when one is, and the largest repeat', () => {
    const graph = buildGraph(
      [
        createSimulation('pass in round 1', ['dev a r1', 'check a r1', 'dev b r1', 'check b r1'], DONE, { when: 'round 1' }),
        createSimulation('pass in round 2', SEQ_ROUND_2_LABELS, DONE, { when: 'round 2' }),
        createSimulation('pass in round 3', ['dev a r1', 'check a r1', 'dev a r2', 'check a r2', 'dev a r3', 'check a r3'], DONE, { when: 'round 2' }),
      ],
      { roles: SEQ_ROLES },
    );
    const checkToDev = graph.edges.filter((edge) => edge.from === 'a2' && edge.to === 'a1');
    // check to dev goes forward in the first scenario and back in the second.
    const mixed = buildGraph([createSimulation('forward', ['check', 'dev']), createSimulation('back', ['dev', 'check', 'dev'])], { roles: SEQ_ROLES });

    assert.deepEqual(checkToDev, [
      { from: 'a2', to: 'a1', whens: ['round 1', 'round 2'], back: false, nextItem: true, repeat: 0 },
      { from: 'a2', to: 'a1', whens: ['round 2'], back: true, nextItem: false, repeat: 3 },
    ]);
    assert.deepEqual(mixed.edges.find((edge) => edge.from === 'a2' && edge.to === 'a1'), { from: 'a2', to: 'a1', whens: ['forward', 'back'], back: true, nextItem: false, repeat: 2 });
  });

  it('gives a graph of JSON values with its nodes, edges, phases and loops in their order', () => {
    const sites = [
      { line: 4, column: 7, template: 'Early', isMessageBuilt: false },
      { line: 9, column: 7, template: 'Late', isMessageBuilt: false },
    ];
    const graph = buildGraph(
      [
        createSimulation('late', [{ label: 'dev a', phase: 'Dev' }], createThrewEnd('Late', [{ line: 9, column: 7 }])),
        createSimulation('early', [{ label: 'check a', phase: 'Audit' }, { label: 'dev a', phase: 'Dev' }, { label: 'check a', phase: 'Audit' }], createThrewEnd('Early', [{ line: 4, column: 7 }])),
        createSimulation('done', ['dev a'], DONE),
      ],
      { roles: ['unused', 'check', 'dev'], throwSites: sites, phases: [{ title: 'Dev', detail: 'Builds.' }, { title: 'Empty' }, 'Plain'] },
    );
    // A meta phase with no title reads as the title '', and an agent node of no phase still joins no phase.
    const phaseLess = buildGraph([createSimulation('a', ['dev a'])], { roles: ['dev'], phases: [{ detail: 'Untitled.' }] });

    assert.deepEqual(JSON.parse(JSON.stringify(graph)), graph);
    assert.deepEqual(
      graph.nodes.map(({ id, kind, label }) => `${id} ${kind} ${label}`),
      ['a1 agent check', 'a2 agent dev', 't1 end done', 'x1 throw throw: Early', 'x2 throw throw: Late'],
    );
    assert.deepEqual(listEdges(graph), ['S0 -> a1 0', 'S0 -> a2 0', 'a1 -> a2 0', 'a1 -> x1 0', 'a2 -back-> a1 2', 'a2 -> t1 0', 'a2 -> x2 0']);
    assert.deepEqual(graph.phases, [
      { id: 'p1', title: 'Dev', detail: 'Builds.', nodes: ['a2'] },
      { id: 'p2', title: 'Empty', detail: '', nodes: [] },
      { id: 'p3', title: '', detail: '', nodes: [] },
      { id: 'p4', title: 'Audit', detail: '(not in meta.phases)', nodes: ['a1'] },
    ]);
    assert.deepEqual(graph.loops, [{ from: 'a2', to: 'a1', whens: ['early'], repeat: 2 }]);
    assert.deepEqual(phaseLess.phases, [{ id: 'p1', title: '', detail: 'Untitled.', nodes: [] }]);
  });

  it('cuts a throw node label before the first clause separator outside brackets, quotes and expressions', () => {
    assert.equal(readThrowLabel('No block — resume with the same args'), 'throw: No block');
    assert.equal(readThrowLabel('Invalid args: no plan'), 'throw: Invalid args');
    assert.equal(readThrowLabel('Invalid args (see the plan)'), 'throw: Invalid args');
    assert.equal(readThrowLabel('No plan; stop'), 'throw: No plan');
    assert.equal(readThrowLabel('Dead in round .... Resume with the same args.'), 'throw: Dead in round ...');
    assert.equal(readThrowLabel('Dead in round ... resumed'), 'throw: Dead in round ... resumed');
    assert.equal(readThrowLabel('Bad  key\n\t"a: b" in [x: y] and {p. q}. Then stop'), 'throw: Bad key "a: b" in [x: y] and {p. q}');
    assert.equal(readThrowLabel("Plan 2's file is gone"), "throw: Plan 2's file is gone");
    assert.equal(readThrowLabel(' \n(see the plan) now\t'), 'throw: (see the plan) now');
  });

  it('labels a throw node of a blank message by whether the runtime builds the message', () => {
    assert.equal(readThrowLabel('', true), 'throw: (message built at runtime)');
    assert.equal(readThrowLabel(' \n ', true), 'throw: (message built at runtime)');
    assert.equal(readThrowLabel(''), 'throw: (no message text)');
    assert.equal(readThrowLabel(' \n '), 'throw: (no message text)');
  });

  it('cuts a message whose brackets or quotes do not balance before the earliest separator past its start', () => {
    assert.equal(readThrowLabel('Bad(key. x: y'), 'throw: Bad(key');
    assert.equal(readThrowLabel('Bad "key: x'), 'throw: Bad "key');
    assert.equal(readThrowLabel('Bad key) x'), 'throw: Bad key) x');
    assert.equal(readThrowLabel('f(... rest'), 'throw: f(... rest');
    assert.equal(readThrowLabel('Bad [... rest. Then stop'), 'throw: Bad [... rest');
    assert.equal(readThrowLabel(': Bad'), 'throw: ');
  });

  it('leaves unmapped a stopped simulation and a refused script with the end that dwfb simulate prints', () => {
    const stop = { kind: 'stopped', reason: 'unanswered', message: 'No scripted return for call 0 (label "dev a")', call: 0 };
    const unmapped = findUnmapped([createSimulation('stops', ['dev a'], stop), createSimulation('refused', [], { kind: 'refused', findings: [] })], { roles: SEQ_ROLES });

    assert.deepEqual(unmapped, [
      { scenario: 'stops', reason: 'stopped at call 0 (label "dev a"): No scripted return for call 0 (label "dev a")' },
      { scenario: 'refused', reason: 'refused' },
    ]);
  });
});
