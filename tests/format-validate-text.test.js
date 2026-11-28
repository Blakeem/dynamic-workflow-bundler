import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatValidateText } from '../src/format-validate-text.js';

const FINDING = { rule: 'meta-not-first', message: 'The script does not open with meta', fix: 'Move meta first', file: 'bad.js', line: 1, column: 1 };

describe('formatValidateText', () => {
  it('prints a line for each clean script, the findings of each other script, then each skipped workflow', () => {
    const results = [
      { ok: true, script: 'good.js', runtime: '2.1.332', findings: [] },
      { ok: false, script: 'bad.js', runtime: '2.1.332', findings: [FINDING] },
    ];
    assert.equal(formatValidateText(results, ['skip.js']), [
      'good.js breaks no rule of the contract measured on Claude Code 2.1.332.',
      'bad.js:1:1 meta-not-first The script does not open with meta. Move meta first.',
      'Skipped skip.js, since its workflow sets validate: false.',
      '',
    ].join('\n'));
  });

  it('prints nothing for no script and no skipped workflow', () => {
    assert.equal(formatValidateText([], []), '');
  });
});
