import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OUTCOME_CASES } from './fixtures/outcome/cases.js';

/** @typedef {import('./fixtures/outcome/cases.js').OutcomeCase} OutcomeCase */

const COMMAND = fileURLToPath(new URL('../bin/dwfb.js', import.meta.url));
const INTERNAL_FAILURE = 'internal failure';
const STACK_TRACE_LINE = /^\s+at /m;
const FINDING_RULE = /^.*?:\d+:\d+ ([a-z]+(?:-[a-z]+)*) /;
// The codes of a file name the platform refuses.
const REFUSED_NAME_CODES = new Set(['EILSEQ', 'EINVAL', 'ENAMETOOLONG']);

const caseRoot = await mkdtemp(join(tmpdir(), 'dwfb-outcome-'));
let caseCount = 0;
after(async () => {
  await rm(caseRoot, { recursive: true, force: true });
});

/**
 * @param {OutcomeCase} outcomeCase
 * @returns {Promise<{ folder: string, failedFile: string | null, failure: string | null }>} The case's new
 *   folder, and the file the platform could not create with its error code.
 */
async function writeCase(outcomeCase) {
  caseCount += 1;
  const folder = join(caseRoot, String(caseCount));

  await mkdir(folder);
  for (const [file, content] of Object.entries(outcomeCase.files)) {
    const text = typeof content === 'function' ? content(folder) : content;
    try {
      await mkdir(dirname(join(folder, file)), { recursive: true });
      await writeFile(join(folder, file), text);
    } catch (error) {
      if (!REFUSED_NAME_CODES.has(error.code)) throw error;
      return { folder, failedFile: file, failure: error.code };
    }
  }
  return { folder, failedFile: null, failure: null };
}

/**
 * @param {OutcomeCase} outcomeCase
 * @param {import('node:test').TestContext} context
 */
async function checkCase(outcomeCase, context) {
  const { folder, failedFile, failure } = await writeCase(outcomeCase);
  if (failedFile !== null) return context.skip(`the platform cannot create the file ${failedFile} (${failure})`);

  const { status, stdout, stderr } = spawnSync(process.execPath, [COMMAND, ...outcomeCase.args], { cwd: folder, encoding: 'utf8' });
  const output = `${stdout}${stderr}`;
  const firstRule = FINDING_RULE.exec(stdout)?.[1] ?? null;

  assert.ok(!output.includes(INTERNAL_FAILURE) && !STACK_TRACE_LINE.test(output), `The command ends in an internal failure:\n${output}`);
  assert.equal(status, outcomeCase.exit, `The command exits ${status}, where the case expects ${outcomeCase.exit}:\n${output}`);
  if (outcomeCase.exit === 1) assert.equal(firstRule, outcomeCase.rule, `The first finding has the rule ${firstRule}:\n${output}`);
  if (outcomeCase.message !== undefined) assert.match(output, outcomeCase.message);
}

describe('outcome of the command on odd input', () => {
  for (const outcomeCase of OUTCOME_CASES) {
    it(`${outcomeCase.name} (exit ${outcomeCase.exit}${outcomeCase.rule === undefined ? '' : ` ${outcomeCase.rule}`})`, (context) => checkCase(outcomeCase, context));
  }
});
