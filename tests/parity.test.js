import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'dynamic-workflow-bundler';
import { PARITY_CASES } from './fixtures/parity/cases.js';
import { GRID_CASES } from './fixtures/parity/grid.js';
import { runBuiltScript } from './support/run-built-script.js';

/** @typedef {import('./fixtures/parity/cases.js').ParityCase} ParityCase */
/** @typedef {import('./fixtures/parity/cases.js').Settled} Settled */

const PARITY_ENTRY = "export const meta = { name: 'parity', description: 'parity' };\nimport result from './main.js';\nreturn await result;\n";
// Node.js 22.0 to 22.6 reads a .js file of a package with no "type" as CommonJS.
const MODULE_PACKAGE = '{ "type": "module" }\n';

const caseRoot = await mkdtemp(join(tmpdir(), 'dwfb-parity-'));
let caseCount = 0;
after(async () => {
  await rm(caseRoot, { recursive: true, force: true });
});

/**
 * @param {ParityCase} parityCase
 * @returns {Promise<string>} A new folder that holds the case's files, the entry and the package.json.
 */
async function writeCase(parityCase) {
  caseCount += 1;
  const folder = join(caseRoot, String(caseCount));
  const files = { ...parityCase.files, 'entry.js': PARITY_ENTRY, 'package.json': MODULE_PACKAGE };

  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(folder, file)), { recursive: true });
    await writeFile(join(folder, file), text);
  }
  return folder;
}

/**
 * @param {() => Promise<unknown>} produce
 * @returns {Promise<Settled>} The value after a JSON round trip, which maps undefined to null. A value that
 *   does not serialize, such as a BigInt, rejects, so it fails the case.
 */
async function settle(produce) {
  let value = null;

  try {
    value = await produce();
  } catch (error) {
    return { thrown: error?.constructor?.name ?? Object.prototype.toString.call(error) };
  }

  return { value: JSON.parse(JSON.stringify(value) ?? 'null') };
}

/**
 * @param {string} folder
 * @returns {Promise<Settled>} The default export of main.js as Node's ES module loader gives it, awaited.
 */
function settleReference(folder) {
  return settle(async () => (await import(pathToFileURL(join(folder, 'main.js')).href)).default);
}

/** @param {ParityCase} parityCase */
async function checkCase(parityCase) {
  const folder = await writeCase(parityCase);
  const result = await build({ entry: join(folder, 'entry.js'), out: join(folder, 'out', 'built.js'), write: false });
  const findings = result.findings.map((finding) => `${finding.rule} ${finding.file}:${finding.line}:${finding.column} ${finding.message}`);

  if (parityCase.expected === 'refused') {
    assert.ok(result.findings.some((finding) => finding.rule === parityCase.rule), `The build gives no ${parityCase.rule} finding. Findings: ${JSON.stringify(findings)}`);
    return;
  }
  assert.deepEqual(findings, [], 'The build gives a finding');
  const reference = await settleReference(folder);
  const built = await settle(async () => (await runBuiltScript(/** @type {string} */ (result.script), {})).value);
  const isEqual = isDeepStrictEqual(reference, built);

  if (parityCase.expected === 'equal') {
    assert.ok(isEqual, `ES modules give ${JSON.stringify(reference)}, and the built script gives ${JSON.stringify(built)}`);
    return;
  }
  assert.ok(!isEqual, `The built script now gives what ES modules give, ${JSON.stringify(built)}, so the deviation "${parityCase.difference}" is gone. Mark the case equal and remove the deviation from README.md`);
  assert.deepEqual(built, parityCase.actual, `The built script gives a result other than the deviation "${parityCase.difference}" states. Update the case and README.md`);
}

describe('parity of a built script with ES modules', () => {
  for (const parityCase of [...PARITY_CASES, ...GRID_CASES]) {
    it(`${parityCase.name} (${parityCase.expected})`, () => checkCase(parityCase));
  }
});
