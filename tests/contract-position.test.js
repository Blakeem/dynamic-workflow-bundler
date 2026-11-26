import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'dynamic-workflow-bundler';
import { checkContract } from '../src/check-contract.js';
import { normalizeSourceText } from '../src/normalize-source-text.js';
import { CONTRACT_CASES } from './fixtures/contract/cases.js';

/** @typedef {import('../src/finding.js').Finding} Finding */

const CASE_FOLDER = fileURLToPath(new URL('./fixtures/contract/cases/', import.meta.url));
// The cases that hold an import, a source rule or code too deep for a source stop the build before the contract check.
const BUILT_CASE_MINIMUM = 80;

const caseRoot = await mkdtemp(join(tmpdir(), 'dwfb-contract-position-'));
after(async () => {
  await rm(caseRoot, { recursive: true, force: true });
});

/**
 * @param {string} text
 * @param {{ line: number, column: number }} position 1-based.
 * @returns {string | undefined} The character at the position, with LF as the one line break.
 */
function readCharacter(text, { line, column }) {
  return text.split('\n')[line - 1]?.[column - 1];
}

/**
 * @param {Finding[]} findings
 * @returns {string[]} The distinct rule ids, sorted.
 */
function listRules(findings) {
  return [...new Set(findings.map((finding) => finding.rule))].sort();
}

describe('contract findings of a build at their source positions', async () => {
  const builtCases = [];

  for (const contractCase of CONTRACT_CASES) {
    const entry = join(caseRoot, `${contractCase.id}.js`);
    const out = join(caseRoot, `${contractCase.id}.out.js`);
    await writeFile(entry, await readFile(join(CASE_FOLDER, `${contractCase.id}.js`)));
    // The banner moves each line after meta down one, so a finding left at its built position fails the character check.
    const unvalidated = await build({ entry, out, write: false, validate: false });
    if (unvalidated.status === 'built') builtCases.push({ id: contractCase.id, entry, out, script: unvalidated.script });
  }

  it(`builds at least ${BUILT_CASE_MINIMUM} cases with validate: false`, () => {
    assert.ok(builtCases.length >= BUILT_CASE_MINIMUM, `${builtCases.length} cases build`);
  });

  for (const { id, entry, out, script } of builtCases) {
    it(`${id} gets the rules of its built script, each at a source character equal to the built script's`, async () => {
      const sourceText = normalizeSourceText(await readFile(entry, 'utf8'));
      const result = await build({ entry, out, write: false });
      const scriptFindings = checkContract(script, 'built.js');

      assert.deepEqual(listRules(result.findings), listRules(scriptFindings));
      assert.equal(result.findings.length, scriptFindings.length);
      result.findings.forEach((finding, index) => {
        assert.equal(readCharacter(sourceText, finding), readCharacter(script, scriptFindings[index]), `${finding.rule} at ${finding.line}:${finding.column}`);
      });
    });
  }
});
