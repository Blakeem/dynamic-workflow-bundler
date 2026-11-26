import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nameScope } from '../src/join-modules.js';

describe('nameScope', () => {
  it('names a scope from its path, with the reserved prefix', () => {
    assert.match(nameScope('lib/join-modules.js'), /^__dwfb_lib_join_modules_js_[0-9a-f]{8}$/);
    assert.equal(nameScope('lib/a.js'), nameScope('lib/a.js'));
  });

  it('keeps apart paths that differ only in punctuation', () => {
    const names = ['lib/a-b.js', 'lib/a_b.js', 'lib/a.b.js', 'lib/a/b.js'].map(nameScope);
    assert.equal(new Set(names).size, names.length);
  });

  it('gives a valid identifier for a path outside the entry folder or with other letters', () => {
    for (const path of ['../shared/x.js', 'lib/ünicode.js', '__/x.mjs']) {
      assert.doesNotThrow(() => new Function(`const ${nameScope(path)} = 1;`));
    }
  });
});
