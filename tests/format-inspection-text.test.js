import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_CALL_LIMIT } from '../src/contract.js';
import { formatInspectionText } from '../src/format-inspection-text.js';

const FINDING = { rule: 'meta-not-first', message: 'The script does not open with meta', fix: 'Move meta first', file: 'flow.js', line: 1, column: 1 };
const RETURNED = { kind: 'returned', value: 1 };
const PARALLEL = { index: 0, kind: 'parallel', item: 2, items: 3, stage: 0, stages: 1 };
const PIPELINE = { index: 1, kind: 'pipeline', item: 0, items: 2, stage: 1, stages: 2 };

/**
 * @param {import('../src/simulate.js').TraceEnd} end
 * @param {number} [callCount]
 * @returns {import('../src/format-trace-line.js').Simulation}
 */
function createSimulation(end, callCount = 1) {
  const calls = Array.from({ length: callCount }, (_, index) => ({ index, label: 'review', prompt: 'p', opts: null, group: null, phase: null }));
  const trace = { script: 'flow.js', scenario: 'passes', runtime: '2.1.332', end, calls, groups: [], phases: [], logs: [], events: [] };
  return { script: 'flow.js', scenario: 'passes', expect: 'returned', passed: true, trace };
}

/**
 * @param {Partial<import('../src/create-inspection.js').InspectionCall>} fields
 * @returns {import('../src/create-inspection.js').InspectionCall}
 */
function createCall(fields) {
  return { index: 0, label: 'review', phase: null, group: null, opts: null, prompt: 'Review it', ...fields };
}

/**
 * @param {import('../src/simulate.js').TraceEnd} end
 * @param {import('../src/create-inspection.js').InspectionCall} call
 * @returns {string}
 */
function formatCallText(end, call) {
  return formatInspectionText(createSimulation(end), { script: 'flow.js', scenario: 'passes', runtime: '2.1.332', end, callCount: 1, call });
}

describe('formatInspectionText', () => {
  it('prints the findings of a refused script and the line of how the simulation ended', () => {
    const end = { kind: 'refused', findings: [FINDING] };
    const text = formatInspectionText(createSimulation(end, 0), { script: 'flow.js', scenario: 'passes', runtime: '2.1.332', end, callCount: 0 });
    assert.equal(text, 'flow.js:1:1 meta-not-first The script does not open with meta. Move meta first.\nflow.js passes: refused, 0 calls.\n');
  });

  it('prints the line of how the simulation ended, then one line per event', () => {
    const events = [
      { kind: 'phase', title: 'Draft' },
      { kind: 'log', text: 'two\tparts' },
      { kind: 'call', index: 0, label: 'draft', phase: 'Draft', group: null, promptLength: 1, returnedType: 'string', returnedLength: 1 },
      { kind: 'call', index: 1, label: 'review', phase: null, group: PARALLEL, promptLength: 2, returnedType: 'object', returnedLength: null },
      { kind: 'call', index: 2, label: null, phase: null, group: PIPELINE, promptLength: 2, returnedType: 'null', returnedLength: null },
      { kind: 'call', index: 3, label: 'late', phase: null, group: null, promptLength: 2, returnedType: 'none', returnedLength: null },
    ];
    const text = formatInspectionText(createSimulation(RETURNED, 4), { script: 'flow.js', scenario: 'passes', runtime: '2.1.332', end: RETURNED, callCount: 4, events });
    assert.equal(text, [
      'flow.js passes: returned, 4 calls.',
      'phase "Draft"',
      'log two\\u{0009}parts',
      'call 0 (label "draft"): phase "Draft", prompt of 1 character, returned a string of 1 character.',
      'call 1 (label "review"): parallel 0 item 2, prompt of 2 characters, returned an object.',
      'call 2 (no label): pipeline 1 item 0 stage 1, prompt of 2 characters, returned null.',
      'call 3 (label "late"): prompt of 2 characters, no return.',
      '',
    ].join('\n'));
  });

  it('prints one call in full, with a line end after a prompt and a string return that end with none', () => {
    const text = formatCallText(RETURNED, createCall({ phase: 'Draft', group: PARALLEL, opts: { label: 'review' }, returned: 'Done' }));
    assert.equal(text, [
      'call 0 (label "review") of flow.js passes',
      'phase: "Draft"',
      'group: parallel 0, item 2 of 3',
      'options:',
      '{',
      '  "label": "review"',
      '}',
      'prompt of 9 characters:',
      'Review it',
      'returned a string of 4 characters:',
      'Done',
      '',
    ].join('\n'));
  });

  it('names no phase, no group and no options, and a pipeline group with its stage', () => {
    assert.match(formatCallText(RETURNED, createCall({ returned: null })), /^call 0 \(label "review"\) of flow\.js passes\nphase: none\ngroup: none\noptions: none, or options that JSON cannot hold\n/);
    assert.match(formatCallText(RETURNED, createCall({ group: PIPELINE, returned: null })), /\ngroup: pipeline 1, item 0 of 2, stage 1 of 2\n/);
  });

  it('prints each kind of return of one call', () => {
    assert.match(formatCallText(RETURNED, createCall({ prompt: 'Review it\n', returned: null })), /\nReview it\nreturned: null, an agent that died\n$/);
    assert.match(formatCallText(RETURNED, createCall({ returned: { ok: true } })), /\nreturned:\n\{\n {2}"ok": true\n\}\n$/);
    assert.match(formatCallText({ kind: 'stopped', reason: 'unanswered', message: 'No key\there', call: 0 }, createCall({})), /\nstopped: No key\\u\{0009\}here\n$/);
  });

  it('says why a call made after the script settled has no return', () => {
    assert.match(formatCallText(RETURNED, createCall({})), /\nno return, since the script had settled and the scenario holds no usable scripted return for this call\n$/);
    const capText = formatCallText(RETURNED, createCall({ index: AGENT_CALL_LIMIT }));
    assert.match(capText, new RegExp(`\\nno return, since the script had settled and the call came after the cap of ${AGENT_CALL_LIMIT} agent\\(\\) calls\\n$`));
  });
});
