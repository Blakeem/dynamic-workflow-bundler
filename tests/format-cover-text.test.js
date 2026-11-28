import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCoverText } from '../src/format-cover-text.js';

const GAP_FINDING = { rule: 'role-unreached', message: 'No scenario reaches the role "audit"', fix: 'Add a scenario whose simulation makes a call of the role, or put // @unreached <reason> on the line above its label, with the label on a line that holds no throw site', file: 'flow.js', line: 4, column: 30 };
const CONTRACT_FINDING = { rule: 'meta-not-first', message: 'The script does not open with meta', fix: 'Move meta first', file: 'flow.js', line: 1, column: 1 };

/**
 * @param {Partial<import('../src/cover.js').CoverageResult>} fields
 * @returns {import('../src/cover.js').CoverageResult}
 */
function createResult(fields) {
  return {
    ok: true,
    script: 'flow.js',
    runtime: '2.1.332',
    scenarioCount: 2,
    roles: [{ role: 'plan', line: 2, column: 30, reached: true, unreachedReason: null }],
    throwSites: [{ line: 3, column: 9, template: 'bad', reached: true, unreachedReason: null }],
    endStates: [{ endState: 'done', line: 1, column: 20, reached: true }],
    phases: [{ title: 'Plan', line: 1, column: 50, reached: true }],
    findings: [],
    unread: [],
    ...fields,
  };
}

describe('formatCoverText', () => {
  it('prints the count of scenarios and a line per kind for a script with no gap', () => {
    assert.equal(formatCoverText([createResult({})]), [
      'flow.js: 2 scenarios',
      '  roles: 1 of 1 reached',
      '  throw sites: 1 of 1 reached',
      '  end states: 1 of 1 reached',
      '  phases: 1 of 1 reached',
      '',
    ].join('\n'));
  });

  it('prints each finding of a script with gaps before its count lines, and counts each kind', () => {
    const result = createResult({
      ok: false,
      scenarioCount: 1,
      roles: [{ role: 'plan', line: 2, column: 30, reached: true, unreachedReason: null }, { role: 'audit', line: 4, column: 30, reached: false, unreachedReason: null }],
      throwSites: [],
      phases: [{ title: 'Plan', line: 1, column: 50, reached: false }, { title: 'Audit', line: 1, column: 70, reached: false }],
      findings: [GAP_FINDING],
    });

    assert.equal(formatCoverText([result]), [
      'flow.js:4:30 role-unreached No scenario reaches the role "audit". Add a scenario whose simulation makes a call of the role, or put // @unreached <reason> on the line above its label, with the label on a line that holds no throw site.',
      'flow.js: 1 scenario',
      '  roles: 1 of 2 reached',
      '  throw sites: 0 of 0 reached',
      '  end states: 1 of 1 reached',
      '  phases: 0 of 2 reached',
      '',
    ].join('\n'));
  });

  it('counts only the throw sites with no mark, then the count of marked ones', () => {
    const throwSites = [
      { line: 3, column: 9, template: 'a', reached: true, unreachedReason: null },
      { line: 5, column: 9, template: 'b', reached: false, unreachedReason: null },
      { line: 7, column: 9, template: 'c', reached: false, unreachedReason: 'no input gives it' },
      { line: 9, column: 9, template: 'd', reached: false, unreachedReason: '' },
    ];

    assert.match(formatCoverText([createResult({ throwSites })]), /\n {2}throw sites: 1 of 2 reached, 2 marked unreached\n/);
  });

  it('counts only the roles with no mark, then the count of marked ones', () => {
    const roles = [
      { role: 'plan', line: 2, column: 30, reached: true, unreachedReason: null },
      { role: 'Security', line: 4, column: 30, reached: false, unreachedReason: 'a lens label is data' },
    ];

    assert.match(formatCoverText([createResult({ roles })]), /\n {2}roles: 1 of 1 reached, 1 marked unreached\n/);
  });

  it('prints the end state line of a script that declares no end state', () => {
    assert.match(formatCoverText([createResult({ endStates: null })]), /\n {2}end states: none declared with \/\/ @end-states\n/);
  });

  it('prints a line per unread scenario with its name escaped, and no count line', () => {
    const unread = [{ scenario: 'stops\there', reason: 'stopped at call 0 (label "plan"): No key of respond matches call 0' }];
    const result = createResult({ ok: false, roles: null, throwSites: null, endStates: null, phases: null, unread });

    assert.equal(formatCoverText([result]), 'flow.js stops\\u{0009}here: not read, since stopped at call 0 (label "plan"): No key of respond matches call 0.\n');
  });

  it('prints the findings of a refused script before a line per unread scenario', () => {
    const unread = [{ scenario: 'first', reason: 'refused' }, { scenario: 'second', reason: 'refused' }];
    const result = createResult({ ok: false, roles: null, throwSites: null, endStates: null, phases: null, findings: [CONTRACT_FINDING], unread });

    assert.equal(formatCoverText([result]), [
      'flow.js:1:1 meta-not-first The script does not open with meta. Move meta first.',
      'flow.js first: not read, since refused.',
      'flow.js second: not read, since refused.',
      '',
    ].join('\n'));
  });

  it('prints the lines of each script in order', () => {
    const second = createResult({ script: 'other.js', scenarioCount: 1 });

    assert.match(formatCoverText([createResult({}), second]), /^flow\.js: 2 scenarios\n[^]*\nother\.js: 1 scenario\n {2}roles: 1 of 1 reached\n[^]*phases: 1 of 1 reached\n$/);
  });
});
