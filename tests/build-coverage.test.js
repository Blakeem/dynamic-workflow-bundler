import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCoverage } from '../src/build-coverage.js';
import { FIXES } from '../src/finding.js';
import { formatSimulationEnd } from '../src/format-simulation-end.js';
import { placeOf } from './support/place-of.js';

const FILE = 'scripts/s.js';
const PLAIN_META = "export const meta = { name: 's', description: 'd' };\n";
const PHASES_META = "export const meta = { name: 's', description: 'd', phases: [{ title: 'Plan' }, { title: 'Build' }] };\n";
const RETURNED_NOTHING = { kind: 'returned', value: null };

/**
 * @typedef {object} RunSpec
 * @property {{ label?: string | null, phase?: string | null }[]} [calls]
 * @property {{ title: string, beforeCall: number }[]} [phases] Each phase() invocation, with the count of calls before it.
 * @property {unknown} [end] The trace's end. Defaults to a return of null.
 * @property {string | null} [endState]
 */

/**
 * @param {string} name
 * @param {RunSpec} [spec]
 * @returns {import('../src/build-coverage.js').CoverageSimulation}
 */
function createRun(name, { calls = [], phases = [], end = RETURNED_NOTHING, endState = null } = {}) {
  const traceCalls = calls.map(({ label = null, phase = null }, index) => ({ index, label, prompt: '', opts: null, group: null, phase }));
  const events = [];

  for (let callIndex = 0; callIndex <= traceCalls.length; callIndex += 1) {
    phases.forEach((phase, index) => {
      if (phase.beforeCall === callIndex) events.push({ kind: 'phase', index });
    });
    if (callIndex < traceCalls.length) events.push({ kind: 'call', index: callIndex });
  }
  const trace = { script: FILE, scenario: name, runtime: '2.1.332', end, calls: traceCalls, groups: [], phases, logs: [], events };

  return { name, endState, trace: /** @type {import('../src/simulate.js').Trace} */ (trace) };
}

/**
 * @param {string} text The entire script.
 * @param {import('../src/build-coverage.js').CoverageSimulation[]} runs
 * @returns {import('../src/build-coverage.js').Coverage}
 */
function coverText(text, runs) {
  return buildCoverage({ file: FILE, text, contractFindings: [], runs });
}

/**
 * @param {string} rule
 * @param {string} message
 * @param {{ line: number, column: number }} place
 * @returns {import('../src/finding.js').Finding}
 */
function createExpectedFinding(rule, message, { line, column }) {
  return { rule, message, fix: /** @type {string} */ (FIXES[rule]), file: FILE, line, column };
}

/**
 * @param {number} line
 * @param {number} column
 * @returns {{ kind: 'threw', name: string, message: string, frames: { line: number, column: number }[] }}
 */
function createThrowEnd(line, column) {
  return { kind: 'threw', name: 'Error', message: 'm', frames: [{ line, column }] };
}

describe('buildCoverage rules', () => {
  it('end-states-misplaced', () => {
    const broken = `${PLAIN_META}// @end-states\nlet A = ['done'];\n`;
    const passing = `${PLAIN_META}// @end-states\nconst A = ['done'];\nreturn { status: 'done' };\n`;

    assert.deepEqual(coverText(broken, [createRun('a')]).findings, [
      createExpectedFinding('end-states-misplaced', 'The // @end-states comment is not alone on the line above a const that lists end states', { line: 2, column: 1 }),
    ]);
    assert.deepEqual(coverText(passing, [createRun('a', { end: { kind: 'returned', value: { status: 'done' } } })]).findings, []);
  });

  it('unreached-misplaced', () => {
    const broken = `${PLAIN_META}// @unreached reason\nfoo();\n`;
    const passing = `${PLAIN_META}// @unreached reason\nthrow new Error('x');\n`;

    assert.deepEqual(coverText(broken, [createRun('a')]).findings, [
      createExpectedFinding('unreached-misplaced', 'The // @unreached comment is not alone on the line above a throw site', { line: 2, column: 1 }),
    ]);
    assert.deepEqual(coverText(passing, [createRun('a')]).findings, []);
  });

  it('unreached-no-reason, and a comment with no reason still marks its throw site', () => {
    const broken = `${PLAIN_META}  // @unreached\nthrow new Error('x');\n`;
    const passing = `${PLAIN_META}  // @unreached reason\nthrow new Error('x');\n`;
    const brokenCoverage = coverText(broken, [createRun('a')]);

    assert.deepEqual(brokenCoverage.findings, [createExpectedFinding('unreached-no-reason', 'The // @unreached comment gives no reason', { line: 2, column: 3 })]);
    assert.equal(brokenCoverage.throwSites?.[0].unreachedReason, '');
    assert.deepEqual(coverText(passing, [createRun('a')]).findings, []);
  });

  it('role-unreached, at the value of the first label property that gives the role', () => {
    const text = `${PLAIN_META}await agent('p', { label: 'dev' });\nawait agent('p', { label: \`check \${n}\` });\nawait agent('p', { label: 'check' });\n`;

    assert.deepEqual(coverText(text, [createRun('a', { calls: [{ label: 'dev 1' }] })]).findings, [
      createExpectedFinding('role-unreached', 'No scenario reaches the role check', placeOf(text, '`check')),
    ]);
    assert.deepEqual(coverText(text, [createRun('a', { calls: [{ label: 'dev' }] }), createRun('b', { calls: [{ label: 'check 2' }] })]).findings, []);
  });

  it('throw-site-unreached, at the place of the new keyword', () => {
    const text = `${PLAIN_META}if (a) throw new Error('x');\n`;

    assert.deepEqual(coverText(text, [createRun('a')]).findings, [createExpectedFinding('throw-site-unreached', 'No scenario reaches this throw site', { line: 2, column: 14 })]);
    assert.deepEqual(coverText(text, [createRun('a', { end: createThrowEnd(2, 14) })]).findings, []);
  });

  it('throw-site-reached, naming the first scenario in file order that reaches the marked site', () => {
    const text = `${PLAIN_META}// @unreached no input gives it\nthrow new Error('x');\n`;
    const runs = [createRun('first'), createRun('second', { end: createThrowEnd(3, 7) }), createRun('third', { end: createThrowEnd(3, 7) })];

    assert.deepEqual(coverText(text, runs).findings, [
      createExpectedFinding('throw-site-reached', 'The scenario "second" reaches this throw site, which a // @unreached comment marks', { line: 3, column: 7 }),
    ]);
    assert.deepEqual(coverText(text, [createRun('first')]).findings, []);
  });

  it('end-state-unreached, at the string of the end state in its declaration', () => {
    const text = `${PLAIN_META}// @end-states\nconst STATUS = Object.freeze({ done: 'done', halted: 'halted' });\n`;
    const done = createRun('done', { end: { kind: 'returned', value: { status: 'done' } } });
    const halted = createRun('halted', { end: { kind: 'returned', value: { status: 'halted' } } });

    assert.deepEqual(coverText(text, [done]).findings, [createExpectedFinding('end-state-unreached', 'No scenario reaches the end state "halted"', placeOf(text, "'halted'"))]);
    assert.deepEqual(coverText(text, [done, halted]).findings, []);
  });

  it('phase-unreached, at the element of meta.phases', () => {
    const text = `${PHASES_META}await agent('p', { label: 'dev' });\n`;
    const plan = createRun('plan', { calls: [{ label: 'dev', phase: 'Plan' }] });
    const build = createRun('build', { calls: [{ label: 'dev', phase: 'Build' }] });

    assert.deepEqual(coverText(text, [plan]).findings, [
      createExpectedFinding('phase-unreached', 'No scenario makes a call under the phase "Build" of meta.phases', placeOf(text, "{ title: 'Build' }")),
    ]);
    assert.deepEqual(coverText(text, [plan, build]).findings, []);
  });

  it('phase-unlisted, at the start of the meta statement, naming the first scenario that uses the phase', () => {
    const text = `\n${PHASES_META}await agent('p', { label: 'dev' });\n`;
    const listed = createRun('listed', { calls: [{ label: 'dev', phase: 'Plan' }, { label: 'dev', phase: 'Build' }] });
    const unlisted = createRun('unlisted', { calls: [{ label: 'dev', phase: 'Ship' }] });

    assert.deepEqual(coverText(text, [listed, unlisted, createRun('later', { calls: [{ label: 'dev', phase: 'Ship' }] })]).findings, [
      createExpectedFinding('phase-unlisted', 'The scenario "unlisted" uses the phase "Ship", which meta.phases does not list', { line: 2, column: 1 }),
    ]);
    assert.deepEqual(coverText(text, [listed]).findings, []);
  });
});

describe('buildCoverage reach', () => {
  it('lists each role, throw site, end state and phase with its place and whether a scenario reaches it', () => {
    const text = PHASES_META + [
      '// @end-states',
      "const STATUS = ['done', 'halted'];",
      "await agent('p', { label: 'dev', phase: 'Plan' });",
      "if (a) throw new Error('first');",
      '// @unreached a reason',
      "if (b) throw new Error(`second ${b}`);",
      "return { status: 'done' };",
      '',
    ].join('\n');
    const coverage = coverText(text, [createRun('a', { calls: [{ label: 'dev', phase: 'Plan' }], end: { kind: 'returned', value: { status: 'done' } } })]);

    assert.deepEqual(coverage.roles, [{ role: 'dev', ...placeOf(text, "'dev'"), reached: true }]);
    assert.deepEqual(coverage.throwSites, [
      { line: 5, column: 14, template: 'first', reached: false, unreachedReason: null },
      { line: 7, column: 14, template: 'second ...', reached: false, unreachedReason: 'a reason' },
    ]);
    assert.deepEqual(coverage.endStates, [
      { endState: 'done', ...placeOf(text, "'done'"), reached: true },
      { endState: 'halted', ...placeOf(text, "'halted'"), reached: false },
    ]);
    assert.deepEqual(coverage.phases, [
      { title: 'Plan', ...placeOf(text, "{ title: 'Plan' }"), reached: true },
      { title: 'Build', ...placeOf(text, "{ title: 'Build' }"), reached: false },
    ]);
    assert.deepEqual(coverage.unread, []);
  });

  it('reaches an end state with each run of digits written as N on both sides', () => {
    const text = `${PLAIN_META}// @end-states\nconst STATUS = ['round 3 of 5'];\n`;
    const coverage = coverText(text, [createRun('a', { end: { kind: 'returned', value: { status: 'round 12 of 40' } } })]);

    assert.deepEqual(coverage.endStates?.map(({ endState, reached }) => [endState, reached]), [['round 3 of 5', true]]);
    assert.deepEqual(coverage.findings, []);
  });

  it("reads a scenario's endState when the script returns no status, and the status when the two differ", () => {
    const text = `${PLAIN_META}// @end-states\nconst STATUS = ['done', 'halted', 'failed'];\n`;
    const runs = [
      createRun('no status', { end: { kind: 'returned', value: { status: '' } }, endState: 'done' }),
      createRun('differs', { end: { kind: 'returned', value: { status: 'halted' } }, endState: 'failed' }),
      createRun('neither', { end: RETURNED_NOTHING }),
    ];

    assert.deepEqual(coverText(text, runs).endStates?.map(({ reached }) => reached), [true, true, false]);
  });

  it('gives endStates null and no end state finding for a script with no // @end-states comment that declares end states', () => {
    const misplaced = `${PLAIN_META}// @end-states\n\nconst STATUS = ['done'];\n`;

    assert.equal(coverText(`${PLAIN_META}const STATUS = ['done'];\n`, [createRun('a')]).endStates, null);
    assert.equal(coverText(misplaced, [createRun('a')]).endStates, null);
    assert.deepEqual(coverText(misplaced, [createRun('a')]).findings.map(({ rule }) => rule), ['end-states-misplaced']);
  });

  it('reaches no throw site for an error with no frame or with a newest frame at no throw site', () => {
    const text = `${PLAIN_META}throw new Error('x');\n`;
    const runs = [createRun('a', { end: { kind: 'threw', name: 'Error', message: 'm', frames: [] } }), createRun('b', { end: createThrowEnd(2, 1) })];

    assert.deepEqual(coverText(text, runs).throwSites?.map(({ reached }) => reached), [false]);
  });

  it('marks each throw site of the line below one // @unreached comment', () => {
    const text = `${PLAIN_META}// @unreached both\nif (a) throw new Error('x'); else throw new Error('y');\n`;

    assert.deepEqual(coverText(text, [createRun('a')]).throwSites?.map(({ unreachedReason }) => unreachedReason), ['both', 'both']);
    assert.deepEqual(coverText(text, [createRun('a')]).findings, []);
  });

  it('reaches a phase by the phase of a call alone, and uses a phase by a call or a phase() invocation', () => {
    const text = `${PHASES_META}await agent('p', { label: 'dev' });\n`;
    // phase('Build') and phase('Ship') come after the last call, so no call runs under either.
    const run = createRun('a', { calls: [{ label: 'dev', phase: 'Plan' }], phases: [{ title: 'Build', beforeCall: 1 }, { title: 'Ship', beforeCall: 1 }] });
    const coverage = coverText(text, [run]);

    assert.deepEqual(coverage.phases?.map(({ title, reached }) => [title, reached]), [['Plan', true], ['Build', false]]);
    assert.deepEqual(coverage.findings.map(({ rule, message }) => [rule, message]), [
      ['phase-unlisted', 'The scenario "a" uses the phase "Ship", which meta.phases does not list'],
      ['phase-unreached', 'No scenario makes a call under the phase "Build" of meta.phases'],
    ]);
  });

  it('gives one phase-unlisted finding per title, in the order the scenarios first use each title', () => {
    const text = `${PLAIN_META}await agent('p', { label: 'dev' });\n`;
    const first = createRun('first', { calls: [{ label: 'dev', phase: 'Two' }], phases: [{ title: 'One', beforeCall: 0 }] });
    const second = createRun('second', { calls: [{ label: 'dev', phase: 'Three' }, { label: 'dev', phase: 'One' }] });

    assert.deepEqual(coverText(text, [first, second]).findings.map(({ message }) => message), [
      'The scenario "first" uses the phase "One", which meta.phases does not list',
      'The scenario "first" uses the phase "Two", which meta.phases does not list',
      'The scenario "second" uses the phase "Three", which meta.phases does not list',
    ]);
  });

  it('counts the title of phase(\'\') and of a phase option \'\' as a used phase, as the runtime groups a call under it', () => {
    const text = `${PLAIN_META}await agent('p', { label: 'dev' });\n`;
    const byInvocation = createRun('invocation', { calls: [{ label: 'dev' }], phases: [{ title: '', beforeCall: 1 }] });
    const byOption = createRun('option', { calls: [{ label: 'dev', phase: '' }] });
    const listed = "export const meta = { name: 's', description: 'd', phases: [{ title: '' }] };\nawait agent('p', { label: 'dev' });\n";

    assert.deepEqual(coverText(text, [byInvocation]).findings.map(({ message }) => message), ['The scenario "invocation" uses the phase "", which meta.phases does not list']);
    assert.deepEqual(coverText(text, [byOption]).findings.map(({ message }) => message), ['The scenario "option" uses the phase "", which meta.phases does not list']);
    assert.deepEqual(coverText(listed, [byOption]).findings, []);
  });

  it('checks no element whose title is no string of 1 or more characters, and gives each element of a repeated title its own result', () => {
    const text = "export const meta = { name: 's', description: 'd', phases: [{ title: 'Plan' }, { detail: 'd' }, { title: '' }, { title: 3 }, 'Plan', { title: 'Plan' }] };\n";
    const coverage = coverText(text, [createRun('a')]);

    assert.deepEqual(coverage.phases?.map(({ title, column }) => [title, column]), [['Plan', placeOf(text, "{ title: 'Plan' }").column], ['Plan', text.lastIndexOf("{ title: 'Plan' }") + 1]]);
    assert.deepEqual(coverage.findings.map(({ rule }) => rule), ['phase-unreached', 'phase-unreached']);
  });

  it('reads the phases of the last phases key of meta, as the value of the meta object keeps it', () => {
    const text = "export const meta = { name: 's', description: 'd', phases: [{ title: 'A' }], 'phases': [{ title: 'B' }, { title: 'C' }] };\n";
    const coverage = coverText(text, [createRun('a')]);

    assert.deepEqual(coverage.phases?.map(({ title, line, column }) => [title, line, column]), [
      ['B', 1, placeOf(text, "{ title: 'B' }").column],
      ['C', 1, placeOf(text, "{ title: 'C' }").column],
    ]);
  });

  it('counts a title that is no string as listed, as the flow map reads it, and gives it no phase-unlisted finding', () => {
    const text = "export const meta = { name: 's', description: 'd', phases: [{ title: 3 }] };\nawait agent('p', { label: 'dev' });\n";
    const coverage = coverText(text, [createRun('a', { calls: [{ label: 'dev', phase: '3' }], phases: [{ title: '4', beforeCall: 1 }] })]);

    assert.deepEqual(coverage.phases, []);
    assert.deepEqual(coverage.findings.map(({ message }) => message), ['The scenario "a" uses the phase "4", which meta.phases does not list']);
  });

  it('sorts the findings by line, then column, and keeps the order of the rules at one place', () => {
    const text = `${PLAIN_META}await agent('p', { label: 'late' });\n// @unreached\nfoo();\nthrow new Error('x');\n`;

    assert.deepEqual(coverText(text, [createRun('a')]).findings.map(({ rule, line }) => [rule, line]), [
      ['role-unreached', 2],
      ['unreached-misplaced', 3],
      ['unreached-no-reason', 3],
      ['throw-site-unreached', 5],
    ]);
  });

  it('writes a hidden character of a role, a title, an end state and a scenario name as its escape', () => {
    const text = `export const meta = { name: 's', description: 'd', phases: [{ title: 'P\\u200D' }] };\n// @end-states\nconst A = ['e\\u200D'];\nawait agent('p', { label: 'r\\u200D' });\n// @unreached r\nthrow new Error('x');\n`;
    const coverage = coverText(text, [createRun('n‍', { end: createThrowEnd(6, 7) })]);

    assert.deepEqual(coverage.findings.map(({ message }) => message), [
      'No scenario makes a call under the phase "P\\u{200D}" of meta.phases',
      'No scenario reaches the end state "e\\u{200D}"',
      'No scenario reaches the role r\\u{200D}',
      'The scenario "n\\u{200D}" reaches this throw site, which a // @unreached comment marks',
    ]);
    assert.equal(coverage.roles?.[0].role, 'r‍');
  });

  it('places each finding and list entry after a byte order mark and at a lone CR', () => {
    const text = `﻿${PLAIN_META}\r// @end-states\rconst A = ['done'];\rthrow new Error('x');\r`;
    const coverage = coverText(text, [createRun('a')]);

    assert.deepEqual(coverage.findings.map(({ rule, line, column }) => [rule, line, column]), [
      ['end-state-unreached', 4, 12],
      ['throw-site-unreached', 5, 7],
    ]);
    assert.deepEqual(coverage.endStates, [{ endState: 'done', line: 4, column: 12, reached: false }]);
    assert.deepEqual(coverage.throwSites, [{ line: 5, column: 7, template: 'x', reached: false, unreachedReason: null }]);
  });
});

describe('buildCoverage unread scenarios', () => {
  it('lists a scenario that stopped, and gives null lists and no finding of the coverage', () => {
    const stopped = createRun('stops', { calls: [{ label: 'dev' }], end: { kind: 'stopped', reason: 'unanswered', message: 'No scripted return', call: 0 } });
    const coverage = coverText(`${PLAIN_META}await agent('p', { label: 'dev' });\nthrow new Error('x');\n`, [createRun('a'), stopped]);

    assert.deepEqual(coverage, {
      roles: null,
      throwSites: null,
      endStates: null,
      phases: null,
      findings: [],
      unread: [{ scenario: 'stops', reason: formatSimulationEnd(stopped.trace) }],
    });
  });

  it('gives the contract findings of a refused script, and each of its scenarios as unread', () => {
    const contractFindings = [{ rule: 'syntax-error', message: 'm', fix: FIXES['syntax-error'], file: FILE, line: 1, column: 1 }];
    const refused = { kind: 'refused', findings: contractFindings };
    const coverage = buildCoverage({ file: FILE, text: 'not parsed (', contractFindings, runs: [createRun('a', { end: refused }), createRun('b', { end: refused })] });

    assert.deepEqual(coverage, {
      roles: null,
      throwSites: null,
      endStates: null,
      phases: null,
      findings: contractFindings,
      unread: [{ scenario: 'a', reason: 'refused' }, { scenario: 'b', reason: 'refused' }],
    });
  });
});
