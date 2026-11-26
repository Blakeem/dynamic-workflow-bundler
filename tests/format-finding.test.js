import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatFinding } from '../src/format-finding.js';

describe('formatFinding', () => {
  it('prints a finding as <file>:<line>:<column> <rule id> <what is wrong>. <how to fix it>.', () => {
    const finding = { rule: 'import-meta', message: 'The file holds import.meta', fix: 'Remove it', file: 'src/a.js', line: 2, column: 5 };
    assert.equal(formatFinding(finding), 'src/a.js:2:5 import-meta The file holds import.meta. Remove it.');
  });
});
