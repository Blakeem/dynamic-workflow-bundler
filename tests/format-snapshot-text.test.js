import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatSnapshotText } from '../src/format-snapshot-text.js';

const FINDING = { rule: 'meta-not-first', message: 'The script does not open with meta', fix: 'Move meta first', file: 'flow.js', line: 1, column: 1 };

/**
 * @param {Partial<import('../src/snapshot.js').SnapshotResult>} fields
 * @returns {import('../src/snapshot.js').SnapshotResult}
 */
function createResult(fields) {
  return { ok: true, script: 'flow.js', runtime: '2.1.332', variants: [], roles: [], callCount: 1, digest: 'd', promptBudgetProblems: [], unread: [], ...fields };
}

describe('formatSnapshotText', () => {
  it('prints the file line, then a line per role with its prompt budget when it has one', () => {
    const roles = [{ role: 'review', characters: 120, promptBudget: 200 }, { role: 'check', characters: 1, promptBudget: null }];

    assert.equal(formatSnapshotText(createResult({ roles }), [], 'Wrote docs/flow.prompts.md.'), 'Wrote docs/flow.prompts.md.\n  review: 120 characters, prompt budget 200\n  check: 1 character\n');
  });

  it('prints a line per prompt budget problem after the role lines', () => {
    const roles = [{ role: 'review', characters: 250, promptBudget: 200 }, { role: 'check', characters: 1, promptBudget: null }];
    const promptBudgetProblems = [
      { role: 'review', kind: 'over', characters: 250, promptBudget: 200 },
      { role: 'check', kind: 'missing', characters: 1, promptBudget: null },
      { role: 'summary', kind: 'unused', characters: null, promptBudget: 50 },
    ];
    const result = createResult({ ok: false, roles, promptBudgetProblems: /** @type {any} */ (promptBudgetProblems) });

    assert.equal(formatSnapshotText(result, [], 'Fresh docs/flow.prompts.md.'), [
      'Fresh docs/flow.prompts.md.',
      '  review: 250 characters, prompt budget 200',
      '  check: 1 character',
      'flow.js review: the largest prompt has 250 characters, 50 over its prompt budget of 200.',
      'flow.js check: the largest prompt has 1 character and the role has no prompt budget, so give it one in promptBudgets.',
      'flow.js summary: promptBudgets names this role, and no scenario makes a call of it.',
      '',
    ].join('\n'));
  });

  it('prints the findings of a refused script before a line per unread scenario, and no file line', () => {
    const unread = [{ scenario: 'first\tone', reason: 'refused' }, { scenario: 'second', reason: 'refused' }];
    const result = createResult({ ok: false, variants: null, callCount: 0, digest: null, unread });

    assert.equal(formatSnapshotText(result, [FINDING], null), [
      'flow.js:1:1 meta-not-first The script does not open with meta. Move meta first.',
      'flow.js first\\u{0009}one: not read, since refused.',
      'flow.js second: not read, since refused.',
      '',
    ].join('\n'));
  });

  it('prints the line of a script whose scenarios make no call, then each prompt budget it leaves unused', () => {
    const promptBudgetProblems = [{ role: 'review', kind: 'unused', characters: null, promptBudget: 50 }];
    const result = createResult({ ok: false, callCount: 0, promptBudgetProblems: /** @type {any} */ (promptBudgetProblems) });

    assert.equal(formatSnapshotText(result, [], null), 'flow.js: no prompt snapshot, since no scenario makes an agent() call.\nflow.js review: promptBudgets names this role, and no scenario makes a call of it.\n');
  });

  it('writes each hidden character of a role as its escape, in a role line and a problem line', () => {
    const roles = [{ role: 're‍view', characters: 9, promptBudget: null }];
    const promptBudgetProblems = [{ role: 're‍view', kind: 'missing', characters: 9, promptBudget: null }];
    const result = createResult({ ok: false, roles, promptBudgetProblems: /** @type {any} */ (promptBudgetProblems) });

    assert.equal(formatSnapshotText(result, [], 'Wrote a.md.'), 'Wrote a.md.\n  re\\u{200D}view: 9 characters\nflow.js re\\u{200D}view: the largest prompt has 9 characters and the role has no prompt budget, so give it one in promptBudgets.\n');
  });
});
