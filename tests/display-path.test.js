import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { describe, it } from 'node:test';
import { formatDisplayPath, formatForwardSlashes, isFolderPath } from '../src/display-path.js';

describe('display-path', () => {
  it('joins the parts of a platform path with forward slashes', () => {
    assert.equal(formatForwardSlashes(['a', 'b', 'c.js'].join(sep)), 'a/b/c.js');
  });

  it('gives a path relative to the working directory', () => {
    assert.equal(formatDisplayPath(join(process.cwd(), 'src', 'a.js')), 'src/a.js');
    assert.equal(formatDisplayPath(join('src', 'a.js')), 'src/a.js');
  });

  it('finds a path whose last segment is empty, . or .., after a / or the platform separator', () => {
    const folderPaths = ['dist/', `dist${sep}`, 'new/.', `new${sep}.`, 'a/b/..', '/'];
    const otherPaths = ['dist', 'dist/out.js', '.', '..', 'a/../out.js', 'dist/.out.js', 'dist/...'];

    assert.deepEqual(folderPaths.filter((path) => !isFolderPath(path)), []);
    assert.deepEqual(otherPaths.filter(isFolderPath), []);
  });

  it('gives . for the working directory', () => {
    assert.equal(formatDisplayPath(process.cwd()), '.');
    assert.equal(formatDisplayPath(''), '.');
  });
});
