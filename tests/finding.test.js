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

  it('holds a fix with no closing period for each rule, and a default for each rule whose fix depends on the name', () => {
    for (const [rule, ruleFix] of Object.entries(FIXES)) {
      const fixes = typeof ruleFix === 'string' ? [ruleFix] : Object.values(ruleFix);
      assert.match(rule, /^[a-z]+(-[a-z]+)*$/);
      if (typeof ruleFix !== 'string') assert.ok(Object.hasOwn(ruleFix, 'default'), rule);
      for (const fix of fixes) assert.ok(typeof fix === 'string' && fix !== '' && !fix.endsWith('.'), rule);
    }
  });

  it('gives the fix of the name the finding reports, and the default fix for any other name or none', () => {
    const fixOf = (name) => createFinding('global-undefined', 'm', 'a.js', '', 0, name).fix;

    assert.equal(fixOf('meta'), FIXES['global-undefined'].meta);
    assert.equal(fixOf('require'), FIXES['global-undefined'].default);
    assert.equal(fixOf('constructor'), FIXES['global-undefined'].default);
    assert.equal(fixOf(null), FIXES['global-undefined'].default);
  });

  it('throws for a rule that FIXES holds no fix for', () => {
    assert.throws(() => createFinding('no-such-rule', 'm', 'a.js', '', 0), /FIXES holds no fix for the rule no-such-rule/);
  });
});
