import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readPhaseText } from '../src/read-phase-text.js';

describe('readPhaseText', () => {
  it('gives the value of the key as text', () => {
    assert.equal(readPhaseText({ title: 'Plan', detail: 'd' }, 'title'), 'Plan');
    assert.equal(readPhaseText({ title: 3 }, 'title'), '3');
    assert.equal(readPhaseText({ title: 'Plan', detail: false }, 'detail'), 'false');
  });

  it("gives '' for a phase that is no object or whose key is missing, undefined or null", () => {
    assert.equal(readPhaseText('Plan', 'title'), '');
    assert.equal(readPhaseText(null, 'title'), '');
    assert.equal(readPhaseText({ detail: 'd' }, 'title'), '');
    assert.equal(readPhaseText({ title: undefined }, 'title'), '');
    assert.equal(readPhaseText({ title: null }, 'title'), '');
  });
});
