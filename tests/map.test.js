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
// Lines 2 and 3 of a script that writeFiles writes, after its meta statement.
const AMBIGUOUS_BODY = "if (args.first) throw new Error(args.message);\nthrow new Error(`${args.message} again`);\n";
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
        { scenario: 'no label', reason: 'call 0 (no label) names no role of the script, whose roles are "work"' },
        { scenario: 'ghost', reason: 'call 0 (label "ghost") names no role of the script, whose roles are "work"' },
        { scenario: 'no status', reason: 'the script returned no status that is a non-empty string, and the scenario names no endState' },
        { scenario: 'differs', reason: 'the script returned the status "done", which differs from the scenario\'s endState "finished"' },
      ],
    );
    assert.equal(stopTrace.end.kind, 'stopped');
    assert.match(parse.reason, /^the script threw SyntaxError with the message ".+", which starts with the fixed text of no throw site$/);
    assert.deepEqual(result.unmapped.at(-1), parse);
  });

  it('leaves unmapped a throw that two throw sites with no fixed start could give, and each scenario of a refused script', async () => {
    const ambiguous = await writeFiles('ambiguous', AMBIGUOUS_BODY, "export default [{ name: 'a', expect: 'threw', args: { message: 'gone' } }];\n");
    const refused = await writeFiles('refused', 'return Date.now();\n', "export default [{ name: 'a' }, { name: 'b' }];\n");

    assert.deepEqual((await map(ambiguous)).unmapped, [
      { scenario: 'a', reason: 'the script threw Error with the message "gone again", which starts with the fixed text of no throw site, and the throw sites at lines 2, 3 each give a message with no fixed start' },
    ]);
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
