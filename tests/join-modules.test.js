import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nameSource } from '../src/join-modules.js';

describe('nameSource', () => {
  it('names a source from its path, with the reserved prefix', () => {
    assert.match(nameSource('lib/join-modules.js'), /^__dwfb_lib_join_modules_js_[0-9a-f]{8}$/);
    assert.equal(nameSource('lib/a.js'), nameSource('lib/a.js'));
  });

  it('keeps apart paths that differ only in punctuation', () => {
    const names = ['lib/a-b.js', 'lib/a_b.js', 'lib/a.b.js', 'lib/a/b.js'].map(nameSource);
    assert.equal(new Set(names).size, names.length);
  });

  it('gives a valid identifier for a path outside the entry folder or with other letters', () => {
    for (const path of ['../shared/x.js', 'lib/ünicode.js', '__/x.mjs', 'prompts/review.md']) {
      assert.doesNotThrow(() => new Function(`const ${nameSource(path)} = 1;`));
    }
  });
});
