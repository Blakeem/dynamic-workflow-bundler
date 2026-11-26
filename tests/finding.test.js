import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFinding, FIXES } from '../src/finding.js';

describe('createFinding', () => {
  it('gives the rule, its fix and the position of the offset', () => {
    assert.deepEqual(createFinding('import-meta', 'The file holds import.meta', '/work/a.js', 'a;\nimport.meta;', 3), {
      rule: 'import-meta',
      message: 'The file holds import.meta',
      fix: FIXES['import-meta'],
      file: '/work/a.js',
      line: 2,
      column: 1,
    });
  });

  it('holds a fix with no closing period for each rule', () => {
    for (const [rule, fix] of Object.entries(FIXES)) {
      assert.match(rule, /^[a-z]+(-[a-z]+)*$/);
      assert.ok(fix !== '' && !fix.endsWith('.'), rule);
    }
  });
});
