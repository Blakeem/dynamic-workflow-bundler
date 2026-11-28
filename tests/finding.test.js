import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFinding, createPlacedFinding, FIXES } from '../src/finding.js';

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

  it('writes each hidden character of the message as its JavaScript escape, once, and keeps the file as it is', () => {
    const finding = createFinding('import-meta', 'The file reads a\u200Db', '/work/a\u200Db.js', '', 0);

    assert.equal(finding.message, 'The file reads a\\u{200D}b');
    assert.equal(finding.file, '/work/a\u200Db.js');
    assert.equal(createFinding('import-meta', finding.message, 'a.js', '', 0).message, finding.message);
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

describe('createPlacedFinding', () => {
  it('gives the finding that createFinding gives, at the place it is given', () => {
    assert.deepEqual(createPlacedFinding('global-undefined', 'Reads a\u200Db', 'a.js', { line: 4, column: 9 }, 'meta'), {
      rule: 'global-undefined',
      message: 'Reads a\\u{200D}b',
      fix: FIXES['global-undefined'].meta,
      file: 'a.js',
      line: 4,
      column: 9,
    });
    assert.throws(() => createPlacedFinding('no-such-rule', 'm', 'a.js', { line: 1, column: 1 }), /FIXES holds no fix for the rule no-such-rule/);
  });
});
