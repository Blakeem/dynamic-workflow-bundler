import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDocumentFileLine } from '../src/format-document-file-line.js';

describe('formatDocumentFileLine', () => {
  it('gives the line of each outcome, and names the document and the script for a stale file', () => {
    const lines = ['wrote', 'unchanged', 'fresh', 'missing', 'stale'].map((outcome) => formatDocumentFileLine(/** @type {any} */ (outcome), 'docs/a.md', 'prompt snapshot', 'a.js'));

    assert.deepEqual(lines, [
      'Wrote docs/a.md.',
      'Unchanged docs/a.md.',
      'Fresh docs/a.md.',
      'Stale docs/a.md: the file is missing.',
      'Stale docs/a.md: the file differs from the prompt snapshot of a.js.',
    ]);
    assert.equal(formatDocumentFileLine('stale', 'docs/a.md', 'flow map', 'a.js'), 'Stale docs/a.md: the file differs from the flow map of a.js.');
  });
});
