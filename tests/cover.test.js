import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, cover, simulate, validate } from 'dynamic-workflow-bundler';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { FIXES } from '../src/finding.js';
import { formatSimulationEnd } from '../src/format-simulation-end.js';
import { formatRealDisplayPath } from '../src/real-path.js';
import { placeOf } from './support/place-of.js';

const FIXTURE_FOLDER = fileURLToPath(new URL('./fixtures/cover/', import.meta.url));
const ANSWER_ALL_SCENARIOS = "export default [{ name: 'a', respond: { '': 'ok' } }];\n";

const folder = await mkdtemp(join(tmpdir(), 'dwfb-cover-'));
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
 * @param {unknown} options
 * @param {string} message
 */
async function assertUsageError(options, message) {
  await assert.rejects(cover(/** @type {any} */ (options)), (error) => error.name === 'UsageError' && error.message === message);
}

describe('cover', () => {
  it('gives each list and each finding of the fixture script', async () => {
    const script = join(FIXTURE_FOLDER, 'gaps.js');
    const scriptPath = await formatRealDisplayPath(script);
    const finding = (rule, message, line, column) => ({ rule, message, fix: FIXES[rule], file: scriptPath, line, column });

    assert.deepEqual(await cover({ script, scenarios: join(FIXTURE_FOLDER, 'gaps.scenarios.js') }), {
      ok: false,
      script: scriptPath,
      runtime: CONTRACT_RUNTIME_VERSION,
      scenarioCount: 2,
      roles: [
        { role: 'plan', line: 16, column: 40, reached: true },
        { role: 'audit', line: 18, column: 43, reached: false },
        { role: 'ship', line: 22, column: 40, reached: true },
      ],
      throwSites: [
        { line: 11, column: 9, template: 'bad mode', reached: true, unreachedReason: null },
        { line: 14, column: 9, template: 'never thrown', reached: false, unreachedReason: null },
        { line: 25, column: 9, template: 'no plan', reached: false, unreachedReason: 'the planner gives a plan for every input' },
      ],
      endStates: [
        { endState: 'done', line: 8, column: 38, reached: true },
        { endState: 'halted', line: 8, column: 54, reached: false },
      ],
      phases: [
        { title: 'Plan', line: 4, column: 12, reached: true },
        { title: 'Audit', line: 4, column: 31, reached: false },
      ],
      findings: [
        finding('phase-unlisted', 'The scenario "ships" uses the phase "Ship", which meta.phases does not list', 1, 1),
        finding('phase-unreached', 'No scenario makes a call under the phase "Audit" of meta.phases', 4, 31),
        finding('end-state-unreached', 'No scenario reaches the end state "halted"', 8, 54),
        finding('throw-site-unreached', 'No scenario reaches this throw site', 14, 9),
        finding('role-unreached', 'No scenario reaches the role audit', 18, 43),
      ],
      unread: [],
    });
  });

  it('gives ok true for a script that its scenarios cover', async () => {
    const files = await writeFiles('covered', "// @end-states\nconst STATUS = ['done'];\nawait agent('Run.', { label: 'work' });\nreturn { status: STATUS[0] };\n", ANSWER_ALL_SCENARIOS);
    const result = await cover(files);

    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
  });

  it("reaches a declared end state by the scenario's endState for a script that returns no status", async () => {
    const files = await writeFiles('end-state', "// @end-states\nconst STATUS = ['done', 'halted'];\nawait agent('Run.', { label: 'work' });\n", "export default [{ name: 'a', respond: { '': 'ok' }, endState: 'done' }];\n");
    const result = await cover(files);

    assert.deepEqual(result.endStates?.map(({ endState, reached }) => [endState, reached]), [['done', true], ['halted', false]]);
    assert.deepEqual(result.findings.map(({ rule }) => rule), ['end-state-unreached']);
  });

  it('gives throw-site-unreached for a throw site whose error the script catches', async () => {
    const body = "try {\n  throw new Error('caught');\n} catch {\n  await agent('Recover.', { label: 'recover' });\n}\nreturn { status: 'done' };\n";
    const result = await cover(await writeFiles('caught', body, ANSWER_ALL_SCENARIOS));

    assert.deepEqual(result.findings.map(({ rule, line, column }) => [rule, line, column]), [['throw-site-unreached', 3, 9]]);
  });

  it('reaches a listed phase by the phase that phase() sets for the calls after it, and lists a phase() title with no call after it', async () => {
    const meta = "export const meta = { name: 'phased', description: 'd', phases: [{ title: 'Build' }, { title: 'Ship' }] };\n";
    const script = join(folder, 'phased.js');
    const scenarios = join(folder, 'phased.scenarios.js');

    await writeFile(script, `${meta}phase('Build');\nawait agent('Run.', { label: 'work' });\nphase('Ship');\nphase('Tidy');\nreturn { status: 'done' };\n`);
    await writeFile(scenarios, ANSWER_ALL_SCENARIOS);
    const result = await cover({ script, scenarios });

    assert.deepEqual(result.phases?.map(({ title, reached }) => [title, reached]), [['Build', true], ['Ship', false]]);
    assert.deepEqual(result.findings.map(({ rule, message }) => [rule, message]), [
      ['phase-unlisted', 'The scenario "a" uses the phase "Tidy", which meta.phases does not list'],
      ['phase-unreached', 'No scenario makes a call under the phase "Ship" of meta.phases'],
    ]);
  });

  it('lists a scenario that stops as unread, with null lists, no finding of the coverage and ok false', async () => {
    const files = await writeFiles('stops', "await agent('Run.', { label: 'work' });\nthrow new Error('x');\n", "export default [{ name: 'a', respond: { '': 'ok' } }, { name: 'stops' }];\n");
    const stoppedTrace = await simulate({ script: files.script, scenario: { name: 'stops' } });
    const result = await cover(files);

    assert.deepEqual(result, {
      ok: false,
      script: await formatRealDisplayPath(files.script),
      runtime: CONTRACT_RUNTIME_VERSION,
      scenarioCount: 2,
      roles: null,
      throwSites: null,
      endStates: null,
      phases: null,
      findings: [],
      unread: [{ scenario: 'stops', reason: formatSimulationEnd(stoppedTrace) }],
    });
  });

  it('gives the contract findings of a refused script, and each of its scenarios as unread', async () => {
    const files = await writeFiles('refused', 'if (\n', "export default [{ name: 'a' }, { name: 'b' }];\n");
    const { findings } = await validate({ script: files.script });
    const result = await cover(files);

    assert.notEqual(findings.length, 0);
    assert.equal(result.ok, false);
    assert.deepEqual(result.findings, findings);
    assert.deepEqual(result.unread, [{ scenario: 'a', reason: 'refused' }, { scenario: 'b', reason: 'refused' }]);
    assert.equal(result.roles, null);
  });

  it('reads both directives of a module from the script that build() gives', async () => {
    // The banner names the entry by a relative path, so the out sits on the entry's drive and the temporary folder holds the copy.
    const buildResult = await build({ entry: join(FIXTURE_FOLDER, 'built', 'entry.js'), out: join(FIXTURE_FOLDER, 'built', 'out.js'), write: false });
    const builtText = /** @type {string} */ (buildResult.script);
    const script = join(folder, 'built.js');

    assert.equal(buildResult.ok, true);
    await writeFile(script, builtText);
    const result = await cover({ script, scenarios: join(FIXTURE_FOLDER, 'built.scenarios.js') });
    const haltedPlace = placeOf(builtText, "'halted'");

    assert.deepEqual(result.endStates, [
      { endState: 'done', ...placeOf(builtText, "'done'"), reached: true },
      { endState: 'halted', ...haltedPlace, reached: false },
    ]);
    assert.deepEqual(result.throwSites, [{ ...placeOf(builtText, "new Error('empty plan')"), template: 'empty plan', reached: false, unreachedReason: 'the planner gives a plan for every input' }]);
    assert.deepEqual(result.findings.map(({ rule, line, column }) => ({ rule, line, column })), [{ rule: 'end-state-unreached', ...haltedPlace }]);
  });

  it('rejects options of another shape', async () => {
    const { scenarios } = await writeFiles('options', "return { status: 'done' };\n", "export default [{ name: 'a' }];\n");

    await assertUsageError(null, 'cover() takes an options object');
    await assertUsageError({ script: 'a.js', scenarios, scenario: 'a' }, 'cover() takes no option scenario');
    await assertUsageError(undefined, 'cover() needs script, the path of a workflow script');
    await assertUsageError({ script: '', scenarios }, 'cover() needs script, the path of a workflow script');
    await assertUsageError({ script: 'a.js' }, 'cover() needs scenarios, the path of a scenarios file');
    await assertUsageError({ script: 'a.js', scenarios: 3 }, 'cover() needs scenarios, the path of a scenarios file');
  });

  it('rejects for a scenarios file that does not load, and names the scenario for a simulation that cannot run', async () => {
    const throwing = await writeFiles('throwing', "await agent('Run.', { label: 'work' });\n", "export default [{ name: 'a', respond: () => { throw new Error('broken'); } }];\n");

    await assert.rejects(cover({ script: throwing.script, scenarios: join(folder, 'missing.scenarios.js') }), { name: 'UsageError' });
    await assert.rejects(cover(throwing), (error) => error.name === 'UsageError' && error.message.includes('with the scenario "a" of'));
  });
});
