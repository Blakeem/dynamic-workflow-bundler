import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatCaseNote, formatConfigFileConflict } from '../src/format-path-conflict.js';

describe('formatCaseNote', () => {
  it('adds a note only for two paths that differ in letter case', () => {
    assert.equal(formatCaseNote('/w/flow.js', '/w/flow.js'), '');
    assert.equal(formatCaseNote('/w/flow.js', '/w/Flow.js'), ' where file names ignore letter case');
  });
});

describe('formatConfigFileConflict', () => {
  it('names the path and the config file the write would replace', () => {
    assert.equal(formatConfigFileConflict('The flow map file docs/flow.md', 'dwfb.config.js', ''), 'The flow map file docs/flow.md names the config file dwfb.config.js, which the write would replace');
  });
});
