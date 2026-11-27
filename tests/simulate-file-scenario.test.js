import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { simulateFileScenario } from '../src/simulate-file-scenario.js';
import { simulate } from '../src/simulate.js';
import { UsageError } from '../src/usage-error.js';

const folder = await mkdtemp(join(tmpdir(), 'dwfb-simulate-file-scenario-'));
const script = join(folder, 'answer.js');
await writeFile(script, "export const meta = { name: 'answer', description: 'd' };\nawait agent('Run.', { label: 'work' });\nreturn { status: 'done' };\n");
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

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

describe('simulateFileScenario', () => {
  it('resolves to the trace that simulate() gives for the scenario', async () => {
    const scenario = { name: 'a', respond: { '': 'ok' } };
    const trace = await simulateFileScenario(script, { name: 'a', expect: 'returned', scenario }, 'answer.scenarios.js');

    assert.deepEqual(trace, await simulate({ script, scenario }));
  });

  it('rejects for a rejection of simulate() with the script, the scenario and the scenarios file, and that rejection as its cause', async () => {
    const respond = () => {
      throw new Error('broken');
    };
    const scenario = { name: 'a\nb', respond };
    const simulateFailure = await findRejection(simulate({ script, scenario }));
    const failure = await findRejection(simulateFileScenario(script, { name: 'a\nb', expect: 'returned', scenario }, 'answer.scenarios.js'));

    assert.ok(failure instanceof UsageError);
    assert.equal(failure.message, `The simulation of ${script} with the scenario "a\\u{000A}b" of answer.scenarios.js cannot run. ${simulateFailure.message}`);
    assert.equal(/** @type {Error} */ (failure.cause).message, simulateFailure.message);
  });
});
