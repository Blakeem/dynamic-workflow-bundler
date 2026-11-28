import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { map, simulate } from 'dynamic-workflow-bundler';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatSimulationEnd } from '../src/format-simulation-end.js';
import { formatRealDisplayPath } from '../src/real-path.js';

const ORACLE_FOLDER = fileURLToPath(new URL('./fixtures/flow-map/', import.meta.url));
const REFERENCE_SOURCES = { derived: 'returned', declared: 'scenario' };
const FIRST_AND_SECOND_SCENARIOS = "export default [{ name: 'first', expect: 'threw', args: { first: true } }, { name: 'second', expect: 'threw', args: {} }];\n";
const GAPS_BODY = [
  'const kind = args?.kind;',
  "if (kind === 'label') await agent('Run.', { label: args.label });",
  "if (kind === 'parse') JSON.parse('{');",
  "await agent('Run.', { label: 'work' });",
  "if (kind === 'no status') return {};",
  "return { status: 'done' };",
  '',
].join('\n');
const GAPS_SCENARIOS = `export default [
  { name: 'stops' },
  { name: 'no label', args: { kind: 'label' }, respond: { '': 'ok' } },
  { name: 'ghost', args: { kind: 'label', label: 'ghost' }, respond: { '': 'ok' } },
  { name: 'no status', args: { kind: 'no status' }, respond: { '': 'ok' } },
  { name: 'differs', endState: 'finished', respond: { '': 'ok' } },
  { name: 'parse', args: { kind: 'parse' }, expect: 'threw' },
  { name: 'maps', respond: { '': 'ok' } },
];
`;

const ANSWER_ALL_SCENARIOS = "export default [{ name: 'a', respond: { '': 'ok' } }];\n";
const DONE_NODE = { id: 't1', kind: 'end', label: 'done', source: 'returned', line: null, scenarios: ['a'], whens: ['a'] };

const folder = await mkdtemp(join(tmpdir(), 'dwfb-map-'));
await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

/**
 * @param {string} name
 * @param {string} body The script after its meta statement.
 * @param {string} scenariosText
 * @returns {Promise<{ script: string, scenarios: string }>} The paths of a new script and its scenarios file.
 */
async function writeFiles(name, body, scenariosText) {
  const script = join(folder, `${name}.js`);
  const scenarios = join(folder, `${name}.scenarios.js`);

  await writeFile(script, `export const meta = { name: '${name}', description: 'd' };\n${body}`);
  await writeFile(scenarios, scenariosText);
  return { script, scenarios };
}

/**
 * Converts a graph of the reference generator to the shape of this project's graph.
 * @param {any} referenceGraph
 * @returns {import('../src/build-flow-graph.js').FlowGraph}
 */
function convertReferenceGraph({ nodes, edges, phases, loops }) {
  const convertNode = ({ key, ...node }) => (node.kind === 'terminal' ? { ...node, kind: 'end', source: REFERENCE_SOURCES[node.source], line: null } : node);
  const convertEdge = ({ from, to, labelled, fromId, toId, boundary, ...edge }) => ({ ...edge, from: fromId, to: toId, nextItem: boundary });

  return { nodes: nodes.map(convertNode), edges: edges.map(convertEdge), phases, loops };
}

/**
 * @param {{ script: string, scenarios: string }} files
 * @returns {Promise<{ id: string, line: number | null, scenarios: string[] }[]>} Each throw node of the graph that map() gives.
 */
async function listThrowNodes(files) {
  const { graph } = await map(files);

  assert.notEqual(graph, null);
  return graph.nodes.filter((node) => node.kind === 'throw').map(({ id, line, scenarios }) => ({ id, line, scenarios }));
}

/**
 * @param {string} id
 * @param {string} role
 * @param {number} concurrency
 * @returns {import('../src/build-flow-graph.js').AgentNode} The node of a role whose calls give no phase and no model.
 */
function createAgentNode(id, role, concurrency) {
  return { id, kind: 'agent', label: role, role, phase: '', model: '', concurrency };
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {import('../src/build-flow-graph.js').FlowEdge} A forward edge that the scenario `a` took.
 */
function createEdge(from, to) {
  return { from, to, whens: ['a'], back: false, nextItem: false, repeat: 0 };
}

/**
 * @param {Promise<unknown>} promise
 * @returns {Promise<Error>} What the promise rejected with.
 */
async function findRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('The promise did not reject');
}

/**
 * @param {unknown} options
 * @param {string} message
 */
async function assertUsageError(options, message) {
  await assert.rejects(map(/** @type {any} */ (options)), (error) => error.name === 'UsageError' && error.message === message);
}

describe('map', () => {
  for (const name of ['seq', 'fan', 'rounds']) {
    it(`gives the graph of the reference generator for the oracle script ${name}`, async () => {
      const script = join(ORACLE_FOLDER, `${name}.js`);
      const result = await map({ script, scenarios: join(ORACLE_FOLDER, `${name}.scenarios.js`) });
      const referenceGraph = JSON.parse(await readFile(join(ORACLE_FOLDER, `${name}.graph.json`), 'utf8'));

      assert.deepEqual(result, {
        ok: true,
        script: await formatRealDisplayPath(script),
        runtime: CONTRACT_RUNTIME_VERSION,
        graph: convertReferenceGraph(referenceGraph),
        unmapped: [],
      });
    });
  }

  it('lists each scenario the graph cannot hold, in file order, and gives no graph', async () => {
    const { script, scenarios } = await writeFiles('gaps', GAPS_BODY, GAPS_SCENARIOS);
    const stopTrace = await simulate({ script, scenario: { name: 'stops' } });
    const result = await map({ script, scenarios });
    const parse = result.unmapped.find((entry) => entry.scenario === 'parse');

    assert.equal(result.ok, false);
    assert.equal(result.graph, null);
    assert.deepEqual(
      result.unmapped.filter((entry) => entry !== parse),
      [
        { scenario: 'stops', reason: formatSimulationEnd(stopTrace) },
        { scenario: 'no label', reason: 'call 0 (no label) names no role of the script, whose roles are "work", so give the call a label that starts with a role' },
        { scenario: 'ghost', reason: 'call 0 (label "ghost") names no role of the script, whose roles are "work", so start the label with a role' },
        { scenario: 'no status', reason: 'the script returned no status that is a non-empty string, and the scenario names no endState' },
        { scenario: 'differs', reason: 'the script returned the status "done", which differs from the scenario\'s endState "finished"' },
      ],
    );
    assert.equal(stopTrace.end.kind, 'stopped');
    // The newest frame of an error of JSON.parse is the call of the script that invoked it.
    assert.match(parse.reason, /^the script threw SyntaxError: .+ at line 4, column 28, which is no throw site$/);
    assert.deepEqual(result.unmapped.at(-1), parse);
  });

  it('gives a throw node to each of two throw sites with the same message text, on two lines or on one', async () => {
    const twoLines = await writeFiles('two-lines', "if (args.first) throw new Error('Gone');\nthrow new Error('Gone');\n", FIRST_AND_SECOND_SCENARIOS);
    const oneLine = await writeFiles('one-line', "if (args.first) throw new Error('Gone'); else throw new Error('Gone');\n", FIRST_AND_SECOND_SCENARIOS);

    assert.deepEqual(await listThrowNodes(twoLines), [
      { id: 'x1', line: 2, scenarios: ['first'] },
      { id: 'x2', line: 3, scenarios: ['second'] },
    ]);
    assert.deepEqual(await listThrowNodes(oneLine), [
      { id: 'x1', line: 2, scenarios: ['first'] },
      { id: 'x2', line: 2, scenarios: ['second'] },
    ]);
  });

  it('ends a throw at the site that created the error, for an error class of the script and a site inside a function', async () => {
    const errorClass = await writeFiles(
      'error-class',
      "class BlockError extends Error {\n  constructor(id) {\n    super(`No block ${id}`);\n    this.name = 'BlockError';\n  }\n}\nthrow new BlockError(args.id);\n",
      "export default [{ name: 'a', expect: 'threw', args: { id: 'b1' } }];\n",
    );
    const inFunction = await writeFiles(
      'in-function',
      "function fail(reason) { throw new Error(reason); }\nif (args.early) fail('early');\nfail('late');\n",
      "export default [{ name: 'early', expect: 'threw', args: { early: true } }, { name: 'late', expect: 'threw', args: {} }];\n",
    );

    assert.deepEqual(await listThrowNodes(errorClass), [{ id: 'x1', line: 8, scenarios: ['a'] }]);
    assert.deepEqual(await listThrowNodes(inFunction), [{ id: 'x1', line: 2, scenarios: ['early', 'late'] }]);
  });

  it('leaves unmapped an error created anywhere but a throw site, and a thrown value with no place', async () => {
    const scenarioText = "export default [{ name: 'a', expect: 'threw', args: {} }];\n";
    const scriptBug = await writeFiles('script-bug', 'const reason = args.missing.text;\nthrow new Error(reason);\n', scenarioText);
    const returned = await writeFiles('returned', "function createError() { return new Error('Gone'); }\nif (args.never) throw new Error('Gone');\nthrow createError();\n", scenarioText);
    const inConstructor = await writeFiles('in-constructor', 'class BlockError extends Error {\n  constructor(block) {\n    super(block.name);\n  }\n}\nthrow new BlockError(args.block);\n', scenarioText);
    const text = await writeFiles('text', "if (args.never) throw new Error('Gone');\nthrow 'Gone';\n", scenarioText);

    assert.deepEqual((await map(scriptBug)).unmapped, [{ scenario: 'a', reason: "the script threw TypeError: Cannot read properties of undefined (reading 'text') at line 2, column 29, which is no throw site" }]);
    assert.deepEqual((await map(returned)).unmapped, [{ scenario: 'a', reason: 'the script threw Error: Gone at line 2, column 33, which is no throw site' }]);
    assert.deepEqual((await map(inConstructor)).unmapped, [{ scenario: 'a', reason: "the script threw TypeError: Cannot read properties of undefined (reading 'name') at line 4, column 17, which is no throw site" }]);
    assert.deepEqual((await map(text)).unmapped, [{ scenario: 'a', reason: 'the script threw Error: Gone, and the simulation recorded no place it was created at' }]);
  });

  it('ends at a throw site an error that the site raises while it creates its error, and a TypeError of a TypeError site', async () => {
    const scenarioText = "export default [{ name: 'a', expect: 'threw', args: {} }];\n";
    const noConstructor = await writeFiles('no-constructor', "const Fail = args.missing;\nthrow new Fail('boom');\n", scenarioText);
    const derivedReturn = await writeFiles('derived-return', "class BlockError extends Error { constructor(m) { super(m); return 1; } }\nthrow new BlockError('boom');\n", scenarioText);
    const proxyTrap = await writeFiles('proxy-trap', "const Fail = new Proxy(Error, { construct() { return 1; } });\nthrow new Fail('boom');\n", scenarioText);
    const noStack = await writeFiles('no-stack', "class Halt { constructor(m) { this.message = m; } }\nthrow new Halt('boom');\n", scenarioText);
    const shadowedName = await writeFiles('shadowed-name', "const TypeError = args.missing;\nthrow new TypeError('boom');\n", scenarioText);
    const spread = await writeFiles('spread', "const parts = args.parts;\nthrow new TypeError(...parts);\n", scenarioText);
    const otherGlobal = await writeFiles('other-global', "const reason = Symbol('s');\nthrow new Error(reason);\n", scenarioText);
    const typeSite = await writeFiles('type-site', "throw new TypeError('Wrong type');\n", scenarioText);
    const siteNode = [{ id: 'x1', line: 3, scenarios: ['a'] }];

    for (const files of [noConstructor, derivedReturn, proxyTrap, shadowedName, spread, otherGlobal]) {
      const trace = await simulate({ script: files.script, scenario: { name: 'a', args: {} } });

      assert.equal(trace.end.name, 'TypeError', files.script);
      assert.deepEqual(await listThrowNodes(files), siteNode, files.script);
    }
    assert.deepEqual((await map(noStack)).unmapped, [{ scenario: 'a', reason: 'the script threw Error: boom, and the simulation recorded no place it was created at' }]);
    assert.deepEqual(await listThrowNodes(typeSite), [{ id: 'x1', line: 2, scenarios: ['a'] }]);
  });

  it('ends at its throw site an error of a class that extends an engine error, and an error whose site spreads its arguments', async () => {
    const scenarioText = "export default [{ name: 'a', expect: 'threw', args: {} }];\n";
    const subclass = await writeFiles('subclass', "class ValidationError extends TypeError {}\nthrow new ValidationError('bad input');\n", scenarioText);
    const spreadParts = await writeFiles('spread-parts', "const parts = ['bad input'];\nthrow new TypeError(...parts);\n", scenarioText);

    assert.deepEqual(await listThrowNodes(subclass), [{ id: 'x1', line: 3, scenarios: ['a'] }]);
    assert.deepEqual(await listThrowNodes(spreadParts), [{ id: 'x1', line: 3, scenarios: ['a'] }]);
  });

  it('folds a group started inside a lane inside that lane, and counts the lanes that held a call of each role at once', async () => {
    const inStage = await writeFiles(
      'in-stage',
      "await pipeline(['u1', 'u2'], (unit) => parallel(['x', 'y'].map((lens) => () => agent('r', { label: `review:${unit}/${lens}` }))), (unit) => agent('v', { label: `verify:${unit}` }));\nreturn { status: 'done' };\n",
      ANSWER_ALL_SCENARIOS,
    );
    const inThunk = await writeFiles(
      'in-thunk',
      "await parallel(['a', 'b'].map((part) => async () => {\n  await parallel(['1', '2'].map((n) => () => agent('d', { label: `draft:${part}/${n}` })));\n  return agent('m', { label: `merge:${part}` });\n}));\nreturn { status: 'done' };\n",
      ANSWER_ALL_SCENARIOS,
    );
    const roundsInLane = await writeFiles(
      'rounds-in-lane',
      "await parallel(['a', 'b'].map((part) => () => parallel([async () => {\n  await agent('r', { label: `review:${part} r1` });\n  return agent('r', { label: `review:${part} r2` });\n}])));\nreturn { status: 'done' };\n",
      ANSWER_ALL_SCENARIOS,
    );

    assert.deepEqual((await map(inStage)).graph, {
      nodes: [createAgentNode('a1', 'review', 4), createAgentNode('a2', 'verify', 2), DONE_NODE],
      edges: [createEdge('S0', 'a1'), createEdge('a1', 'a2'), createEdge('a2', 't1')],
      phases: [],
      loops: [],
    });
    assert.deepEqual((await map(inThunk)).graph, {
      nodes: [createAgentNode('a1', 'draft', 4), createAgentNode('a2', 'merge', 2), DONE_NODE],
      edges: [createEdge('S0', 'a1'), createEdge('a1', 'a2'), createEdge('a2', 't1')],
      phases: [],
      loops: [],
    });
    // Each lane of the inner groups walks review to review once, though the four calls alternate between the lanes.
    assert.deepEqual((await map(roundsInLane)).graph, {
      nodes: [createAgentNode('a1', 'review', 2), DONE_NODE],
      edges: [createEdge('S0', 'a1'), { ...createEdge('a1', 'a1'), back: true, repeat: 2 }, createEdge('a1', 't1')],
      phases: [],
      loops: [{ from: 'a1', to: 'a1', whens: ['a'], repeat: 2 }],
    });
  });

  it('reaches, inside a lane, the roles of the segments before it in every context around it', async () => {
    const backIntoTop = await writeFiles(
      'back-into-top',
      "await agent('c', { label: 'check' });\nawait parallel([async () => {\n  await parallel([() => agent('w', { label: 'work' })]);\n  return agent('c', { label: 'check' });\n}]);\nreturn { status: 'done' };\n",
      ANSWER_ALL_SCENARIOS,
    );

    // The top level reached check before the outer group, so the lane's step from work to check goes back.
    assert.deepEqual((await map(backIntoTop)).graph, {
      nodes: [createAgentNode('a1', 'check', 1), createAgentNode('a2', 'work', 1), DONE_NODE],
      edges: [createEdge('S0', 'a1'), createEdge('a1', 'a2'), createEdge('a1', 't1'), { ...createEdge('a2', 'a1'), back: true, repeat: 2 }],
      phases: [],
      loops: [{ from: 'a2', to: 'a1', whens: ['a'], repeat: 2 }],
    });
  });

  it('folds two groups that ran at the same time as lanes of one segment', async () => {
    const together = await writeFiles(
      'together',
      "await Promise.all([\n  parallel(['1', '2'].map((n) => () => agent('s', { label: `scan:${n}` }))),\n  parallel(['1', '2', '3'].map((n) => () => agent('p', { label: `probe:${n}` }))),\n]);\nawait agent('w', { label: 'report' });\nreturn { status: 'done' };\n",
      ANSWER_ALL_SCENARIOS,
    );

    assert.deepEqual((await map(together)).graph, {
      nodes: [createAgentNode('a1', 'scan', 2), createAgentNode('a2', 'probe', 3), createAgentNode('a3', 'report', 1), DONE_NODE],
      edges: [createEdge('S0', 'a1'), createEdge('S0', 'a2'), createEdge('a1', 'a3'), createEdge('a2', 'a3'), createEdge('a3', 't1')],
      phases: [],
      loops: [],
    });
  });

  it('leaves unmapped a context that makes a call of its own before the last call made in a group it started or in a group nested in it', async () => {
    const unawaited = await writeFiles(
      'unawaited',
      "await parallel([async () => {\n  const scans = parallel(['1', '2'].map((n) => async () => {\n    await agent('x', { label: `scan:${n}` });\n    return agent('x', { label: `scan:${n} again` });\n  }));\n  await agent('y', { label: 'note' });\n  return scans;\n}]);\nreturn { status: 'done' };\n",
      ANSWER_ALL_SCENARIOS,
    );
    // The top level awaits group 0, whose lane leaves group 1 running without await.
    const unawaitedInLane = await writeFiles(
      'unawaited-in-lane',
      "await parallel([() => {\n  parallel(['1', '2'].map((n) => async () => {\n    await agent('x', { label: `scan:${n}` });\n    return agent('x', { label: `scan:${n} again` });\n  }));\n  return 1;\n}]);\nawait agent('y', { label: 'note' });\nreturn { status: 'done' };\n",
      ANSWER_ALL_SCENARIOS,
    );
    // The runtime settles group 0 before `note`, while the lane's promise chain still makes `scan b` after it.
    const settledChain = await writeFiles(
      'settled-chain',
      "await parallel([() => {\n  agent('x', { label: 'scan a' }).then(() => agent('x', { label: 'scan b' }));\n  return 1;\n}]);\nawait agent('y', { label: 'note' });\nreturn { status: 'done' };\n",
      ANSWER_ALL_SCENARIOS,
    );

    assert.deepEqual((await map(unawaited)).unmapped, [
      { scenario: 'a', reason: 'the lane of item 0 of group 0 made call 0 (label "note") before the last call made in group 1, which it started, so the flow map cannot place it' },
    ]);
    assert.deepEqual((await map(unawaitedInLane)).unmapped, [
      { scenario: 'a', reason: 'the top level made call 2 (label "note") before the last call made in group 1, started inside group 0, which it started, so the flow map cannot place it' },
    ]);
    assert.deepEqual((await map(settledChain)).unmapped, [
      { scenario: 'a', reason: 'the top level made call 1 (label "note") before the last call made in group 0, which it started, so the flow map cannot place it' },
    ]);
  });

  it('leaves unmapped each scenario of a refused script', async () => {
    const refused = await writeFiles('refused', 'return Date.now();\n', "export default [{ name: 'a' }, { name: 'b' }];\n");

    assert.deepEqual(await map(refused), {
      ok: false,
      script: await formatRealDisplayPath(refused.script),
      runtime: CONTRACT_RUNTIME_VERSION,
      graph: null,
      unmapped: [
        { scenario: 'a', reason: 'refused' },
        { scenario: 'b', reason: 'refused' },
      ],
    });
  });

  it('rejects options of another shape', async () => {
    const { scenarios } = await writeFiles('options', "return { status: 'done' };\n", "export default [{ name: 'a' }];\n");

    await assertUsageError(null, 'map() takes an options object');
    await assertUsageError({ script: 'a.js', scenarios, scenario: 'a' }, 'map() takes no option scenario');
    await assertUsageError(undefined, 'map() needs script, the path of a workflow script');
    await assertUsageError({ script: '', scenarios }, 'map() needs script, the path of a workflow script');
    await assertUsageError({ script: 'a.js' }, 'map() needs scenarios, the path of a scenarios file');
    await assertUsageError({ script: 'a.js', scenarios: 3 }, 'map() needs scenarios, the path of a scenarios file');
  });

  it('rejects for each problem that loadScenarios() and simulate() reject for, naming the scenario for simulate()', async () => {
    const valid = await writeFiles('valid', "await agent('Run.', { label: 'work' });\nreturn { status: 'done' };\n", "export default [{ name: 'a', respond: { '': 'ok' } }];\n");
    const throwing = await writeFiles('throwing', "await agent('Run.', { label: 'work' });\n", "export default [{ name: 'a', respond: () => { throw new Error('broken'); } }];\n");
    const missingScript = join(folder, 'missing.js');
    const missingScenarios = join(folder, 'missing.scenarios.js');
    const respondFailure = await findRejection(simulate({ script: throwing.script, scenario: { name: 'a', respond: () => { throw new Error('broken'); } } }));
    const missingFailure = await findRejection(simulate({ script: missingScript }));
    const mapFailure = await findRejection(map(throwing));

    await assertUsageError({ script: valid.script, scenarios: missingScenarios }, `The scenarios file ${missingScenarios} does not exist`);
    await assertUsageError({ script: missingScript, scenarios: valid.scenarios }, missingFailure.message);
    assert.equal(mapFailure.name, 'UsageError');
    assert.equal(mapFailure.message, `The simulation of ${throwing.script} with the scenario "a" of ${throwing.scenarios} cannot run. ${respondFailure.message}`);
    assert.equal(/** @type {Error} */ (mapFailure.cause).message, respondFailure.message);
    assert.equal((await map(valid)).ok, true);
  });
});
