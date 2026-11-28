import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatCoverJson } from '../src/format-cover-json.js';

const COVERAGE = Object.freeze({
  scenarioCount: 1,
  roles: [{ role: 'plan', line: 2, column: 30, reached: false }],
  throwSites: [{ line: 3, column: 9, template: 'bad', reached: false, unreachedReason: 'no input gives it' }],
  endStates: null,
  phases: [],
});
const GAP_FINDING = { rule: 'role-unreached', message: 'No scenario reaches the role plan', fix: 'Add a scenario whose simulation makes a call of the role', file: 'gaps.js', line: 2, column: 30 };
const CONTRACT_FINDING = { rule: 'meta-not-first', message: 'The script does not open with meta', fix: 'Move meta first', file: 'refused.js', line: 1, column: 1 };

describe('formatCoverJson', () => {
  it('gives ok, the runtime version once, and each script with its scenarios file in place of its runtime', () => {
    const gaps = { ok: false, script: 'gaps.js', runtime: '2.1.332', ...COVERAGE, findings: [GAP_FINDING], unread: [] };
    const clean = { ok: true, script: 'clean.js', runtime: '2.1.332', ...COVERAGE, roles: [], throwSites: [], findings: [], unread: [] };

    assert.deepEqual(formatCoverJson([{ scenarios: 'gaps.scenarios.js', result: gaps }, { scenarios: 'clean.scenarios.js', result: clean }], false), {
      ok: false,
      runtime: CONTRACT_RUNTIME_VERSION,
      scripts: [
        { ok: false, script: 'gaps.js', scenarios: 'gaps.scenarios.js', ...COVERAGE, findings: [GAP_FINDING], unread: [] },
        { ok: true, script: 'clean.js', scenarios: 'clean.scenarios.js', ...COVERAGE, roles: [], throwSites: [], findings: [], unread: [] },
      ],
    });
  });

  it('gives the null lists, the contract findings and the unread scenarios of a refused script', () => {
    const unread = [{ scenario: 'a', reason: 'refused' }];
    const refused = { ok: false, script: 'refused.js', runtime: '2.1.332', scenarioCount: 1, roles: null, throwSites: null, endStates: null, phases: null, findings: [CONTRACT_FINDING], unread };
    const { scripts } = formatCoverJson([{ scenarios: 's.js', result: refused }], false);

    // deepEqual ignores key order, and the printed JSON holds the keys in this order.
    assert.deepEqual(Object.keys(scripts[0]), ['ok', 'script', 'scenarios', 'scenarioCount', 'roles', 'throwSites', 'endStates', 'phases', 'findings', 'unread']);
    assert.deepEqual(scripts, [
      { ok: false, script: 'refused.js', scenarios: 's.js', scenarioCount: 1, roles: null, throwSites: null, endStates: null, phases: null, findings: [CONTRACT_FINDING], unread },
    ]);
  });

  it('gives ok true when the command passes it', () => {
    assert.deepEqual(formatCoverJson([], true), { ok: true, runtime: CONTRACT_RUNTIME_VERSION, scripts: [] });
  });
});
