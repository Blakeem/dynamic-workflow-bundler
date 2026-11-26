import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { describe, it } from 'node:test';
import { formatDisplayPath, formatForwardSlashes } from '../src/display-path.js';

describe('display-path', () => {
  it('joins the parts of a platform path with forward slashes', () => {
    assert.equal(formatForwardSlashes(['a', 'b', 'c.js'].join(sep)), 'a/b/c.js');
  });

  it('gives a path relative to the working directory', () => {
    assert.equal(formatDisplayPath(join(process.cwd(), 'src', 'a.js')), 'src/a.js');
    assert.equal(formatDisplayPath(join('src', 'a.js')), 'src/a.js');
  });

  it('gives . for the working directory', () => {
    assert.equal(formatDisplayPath(process.cwd()), '.');
    assert.equal(formatDisplayPath(''), '.');
  });
});
