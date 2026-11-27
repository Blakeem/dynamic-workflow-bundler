import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { compileScript } from '../src/compile-script.js';
import { runSimulation } from '../src/run-simulation.js';
import { CONTRACT_CASES } from './fixtures/contract/cases.js';

const CASE_FOLDER = new URL('./fixtures/contract/cases/', import.meta.url);
const SYNC_LOOP_ROW = 'z01-sync-loop';
// A short limit ends the loop of the sync loop row fast.
const SHORT_TIME_LIMIT_MS = 50;
const LEFT_OUT_ROWS = new Map([
  ['t05-agent-arguments', 'The script starts agents.'],
  ['c40-return-value-kinds', 'It was measured as a child script, whose return a parent caught. A launched script with that return fails.'],
  ['c37-deep-recursion', "It recurses in tail position, which the runtime's JavaScript engine runs with no end and Node ends with a RangeError."],
]);
const USING_ROW = 'c05b-using';

/** @returns {boolean} */
function canCompileUsing() {
  try {
    compileScript('{ using x = null }', 0);
    return true;
  } catch {
    return false;
  }
}

if (!canCompileUsing()) LEFT_OUT_ROWS.set(USING_ROW, `Node ${process.version} cannot compile a using declaration.`);

describe('simulation of each contract case the runtime started', () => {
  for (const contractCase of CONTRACT_CASES) {
    if (contractCase.measured === 'refused') continue;
    const reason = LEFT_OUT_ROWS.get(contractCase.id);

    it(`${contractCase.id} ${contractCase.measured}`, { skip: reason ?? false }, async () => {
      const text = await readFile(new URL(`${contractCase.id}.js`, CASE_FOLDER), 'utf8');
      const timeLimit = contractCase.id === SYNC_LOOP_ROW ? SHORT_TIME_LIMIT_MS : undefined;
      let callCount = 0;
      const answerCall = () => {
        callCount += 1;
        return null;
      };
      const { end } = await runSimulation(text, { answerCall }, timeLimit);

      assert.equal(callCount, 0, `${contractCase.id} calls agent()`);
      assert.equal(end.kind, contractCase.measured, JSON.stringify(end));
      if (end.kind !== 'threw') return;
      // A row's message is the error's message, or its name and message.
      assert.ok(end.message.length > 0, `${contractCase.id} ends with an empty message`);
      assert.ok([end.message, `${end.name}: ${end.message}`].includes(contractCase.message), `${contractCase.message} is not ${end.name}: ${end.message}`);
    });
  }
});
