import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { simulate, snapshot } from 'dynamic-workflow-bundler';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatPromptSnapshot } from '../src/format-prompt-snapshot.js';
import { formatSimulationEnd } from '../src/format-simulation-end.js';
import { formatRealDisplayPath } from '../src/real-path.js';

const ORACLE_FOLDER = fileURLToPath(new URL('./fixtures/prompt-snapshot/', import.meta.url));
const ORACLE_FILES = { script: join(ORACLE_FOLDER, 'review.js'), scenarios: join(ORACLE_FOLDER, 'review.scenarios.js') };
const WORK_BODY = "await agent('Run the work.', { label: 'work' });\nawait agent('Check it.', { label: 'check' });\nreturn { status: 'done' };\n";
const ANSWER_ALL_SCENARIOS = "export default [{ name: 'a', respond: { '': 'ok' } }];\n";
const PROMPT_BUDGETS_MESSAGE = 'snapshot() takes promptBudgets as an object that gives a role a whole number of 1 or more';

const folder = await mkdtemp(join(tmpdir(), 'dwfb-snapshot-'));
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
  await assert.rejects(snapshot(/** @type {any} */ (options)), (error) => error.name === 'UsageError' && error.message === message);
}

describe('snapshot', () => {
  it('gives the variants, the roles, the call count and the digest of the reference generator for the oracle script', async () => {
    const oracle = JSON.parse(await readFile(join(ORACLE_FOLDER, 'review.snapshot.json'), 'utf8'));
    const result = await snapshot(ORACLE_FILES);

    assert.deepEqual(result, {
      ok: true,
      script: await formatRealDisplayPath(ORACLE_FILES.script),
      runtime: CONTRACT_RUNTIME_VERSION,
      variants: oracle.variants,
      roles: oracle.roles,
      callCount: oracle.callCount,
      digest: oracle.digest,
      promptBudgetProblems: [],
      unread: [],
    });
    assert.equal(formatPromptSnapshot('review', /** @type {any} */ (result.variants)), await readFile(join(ORACLE_FOLDER, 'review.prompts.md'), 'utf8'));
  });

  it('gives each role its prompt budget and lists each prompt budget problem, which makes the result not ok', async () => {
    const work = await writeFiles('budgets', WORK_BODY, ANSWER_ALL_SCENARIOS);
    const fits = await snapshot({ ...work, promptBudgets: { work: 13, check: 9 } });
    const broken = await snapshot({ ...work, promptBudgets: { work: 12, summary: 40 } });

    assert.equal(fits.ok, true);
    assert.deepEqual(fits.roles, [
      { role: 'work', characters: 13, promptBudget: 13 },
      { role: 'check', characters: 9, promptBudget: 9 },
    ]);
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.promptBudgetProblems, [
      { role: 'work', kind: 'over', characters: 13, promptBudget: 12 },
      { role: 'check', kind: 'missing', characters: 9, promptBudget: null },
      { role: 'summary', kind: 'unused', characters: null, promptBudget: 40 },
    ]);
    assert.notEqual(broken.variants, null);
  });

  it('lists each scenario whose simulation stops as unread, and gives no variant and no digest', async () => {
    const files = await writeFiles('stops', WORK_BODY, "export default [{ name: 'a', respond: { '': 'ok' } }, { name: 'stops' }];\n");
    const stopTrace = await simulate({ script: files.script, scenario: { name: 'stops' } });

    assert.deepEqual(await snapshot({ ...files, promptBudgets: { work: 1 } }), {
      ok: false,
      script: await formatRealDisplayPath(files.script),
      runtime: CONTRACT_RUNTIME_VERSION,
      variants: null,
      roles: [],
      callCount: 0,
      digest: null,
      promptBudgetProblems: [],
      unread: [{ scenario: 'stops', reason: formatSimulationEnd(stopTrace) }],
    });
    assert.equal(stopTrace.end.kind, 'stopped');
  });

  it('lists each scenario of a refused script as unread', async () => {
    const refused = await writeFiles('refused', 'return Date.now();\n', "export default [{ name: 'a' }, { name: 'b' }];\n");
    const result = await snapshot(refused);

    assert.equal(result.ok, false);
    assert.equal(result.variants, null);
    assert.deepEqual(result.unread, [
      { scenario: 'a', reason: 'refused' },
      { scenario: 'b', reason: 'refused' },
    ]);
  });

  it('gives no variant and is not ok for scenarios that make no call', async () => {
    const files = await writeFiles('no-call', "return { status: 'done' };\n", "export default [{ name: 'a' }];\n");
    const result = await snapshot(files);

    assert.equal(result.ok, false);
    assert.deepEqual(result.variants, []);
    assert.deepEqual(result.roles, []);
    assert.equal(result.callCount, 0);
    assert.deepEqual(result.unread, []);
  });

  it('rejects options of another shape', async () => {
    const { scenarios } = await writeFiles('options', "return { status: 'done' };\n", "export default [{ name: 'a' }];\n");

    await assertUsageError(null, 'snapshot() takes an options object');
    await assertUsageError({ script: 'a.js', scenarios, budgets: {} }, 'snapshot() takes no option budgets');
    await assertUsageError(undefined, 'snapshot() needs script, the path of a workflow script');
    await assertUsageError({ script: '', scenarios }, 'snapshot() needs script, the path of a workflow script');
    await assertUsageError({ script: 'a.js' }, 'snapshot() needs scenarios, the path of a scenarios file');
    await assertUsageError({ script: 'a.js', scenarios: 3 }, 'snapshot() needs scenarios, the path of a scenarios file');
  });

  it('rejects a promptBudgets that is no object or that gives a role no whole number of 1 or more', async () => {
    const files = await writeFiles('refused-budgets', WORK_BODY, ANSWER_ALL_SCENARIOS);

    for (const promptBudgets of [null, [], 'work', 3]) await assertUsageError({ ...files, promptBudgets }, PROMPT_BUDGETS_MESSAGE);
    for (const promptBudget of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, '5', null]) {
      await assertUsageError({ ...files, promptBudgets: { check: 9, 'work\n': promptBudget } }, 'snapshot() takes the prompt budget of the role "work\\u{000A}" as a whole number of 1 or more');
    }
    assert.equal((await snapshot({ ...files, promptBudgets: undefined })).ok, true);
  });

  it('rejects for each problem that loadScenarios() and simulate() reject for, naming the scenario for simulate()', async () => {
    const valid = await writeFiles('valid', WORK_BODY, ANSWER_ALL_SCENARIOS);
    const throwing = await writeFiles('throwing', "await agent('Run.', { label: 'work' });\n", "export default [{ name: 'a', respond: () => { throw new Error('broken'); } }];\n");
    const missingScript = join(folder, 'missing.js');
    const missingScenarios = join(folder, 'missing.scenarios.js');
    const respondFailure = await findRejection(simulate({ script: throwing.script, scenario: { name: 'a', respond: () => { throw new Error('broken'); } } }));
    const missingFailure = await findRejection(simulate({ script: missingScript }));
    const snapshotFailure = await findRejection(snapshot(throwing));

    await assertUsageError({ script: valid.script, scenarios: missingScenarios }, `The scenarios file ${missingScenarios} does not exist`);
    await assertUsageError({ script: missingScript, scenarios: valid.scenarios }, missingFailure.message);
    assert.equal(snapshotFailure.name, 'UsageError');
    assert.equal(snapshotFailure.message, `The simulation of ${throwing.script} with the scenario "a" of ${throwing.scenarios} cannot run. ${respondFailure.message}`);
    assert.equal((await snapshot(valid)).ok, true);
  });
});
