import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatErrorCause } from '../src/format-error-cause.js';
import { formatRealDisplayPath } from '../src/real-path.js';

const THIS_FILE = fileURLToPath(import.meta.url);

describe('formatErrorCause', () => {
  it('names an absolute path and a file URL on disk relative to the working directory, and drops the closing period', async () => {
    const displayPath = await formatRealDisplayPath(THIS_FILE);

    assert.equal(await formatErrorCause(new Error(`Cannot read '${THIS_FILE}'.`)), `Cannot read '${displayPath}'`);
    assert.equal(await formatErrorCause(new Error(`Cannot read ${pathToFileURL(THIS_FILE).href}, twice`)), `Cannot read ${displayPath}, twice`);
  });

  it('keeps text that looks like a path and names no place on disk', async () => {
    assert.equal(await formatErrorCause('No match for /^a/'), 'No match for /^a/');
  });

  it('gives a fixed cause for a value with no text', async () => {
    const textless = 'Its code threw a value that has no text';

    assert.equal(await formatErrorCause(new Error('')), textless);
    assert.equal(await formatErrorCause(Object.create(null)), textless);
    assert.equal(await formatErrorCause(' '), textless);
  });
});
