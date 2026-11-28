import { createPlacedFinding } from './finding.js';
import { findRole } from './find-role.js';
import { isObject } from './is-object.js';
import { listUnreadScenarios } from './list-unread-scenarios.js';
import { readKeyName, readMetaObject } from './meta-statement.js';
import { normalizeDigits } from './normalize-digits.js';
import { PARSE_OPTIONS, parseSource } from './parse-source.js';
import { readCoverageDirectives } from './read-coverage-directives.js';
import { readMetaValue } from './read-meta-value.js';
import { readPhaseText } from './read-phase-text.js';
import { readReturnedStatus } from './read-returned-status.js';
import { readRolePlaces } from './read-roles.js';
import { findThrowSiteIndex, readThrowSites } from './read-throw-sites.js';
import { findPosition, readPositionText } from './source-position.js';

/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./simulate.js').Trace} Trace */
/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */
/** @typedef {import('./list-unread-scenarios.js').UnreadScenario} UnreadScenario */

// Findings of one place keep this order.
const RULE_ORDER = [
  'end-states-misplaced',
  'unreached-misplaced',
  'unreached-no-reason',
  'role-unreached',
  'role-reached',
  'throw-site-unreached',
  'throw-site-reached',
  'end-state-unreached',
  'phase-unreached',
  'phase-unlisted',
];
const PHASES_KEY = 'phases';

/**
 * @typedef {object} CoverageSimulation
 * @property {string} name The scenario's name.
 * @property {string | null} endState The scenario's endState.
 * @property {Trace} trace
 */

/**
 * @typedef {object} RoleCoverage
 * @property {string} role
 * @property {number} line The line of the value of the first `label` property that gives the role.
 * @property {number} column
 * @property {boolean} reached
 * @property {string | null} unreachedReason The reason of the first `// @unreached` comment that marks a `label`
 *   property of the role, '' for a mark with no reason, and null for a role with no mark.
 */

/**
 * @typedef {object} ThrowSiteCoverage
 * @property {number} line The line of the `new` keyword.
 * @property {number} column
 * @property {string} template As readThrowSites gives it.
 * @property {boolean} reached
 * @property {string | null} unreachedReason The reason of the `// @unreached` comment that marks the site, ''
 *   for a mark with no reason, and null for a site with no mark.
 */

/**
 * @typedef {object} EndStateCoverage
 * @property {string} endState As its declaration writes it.
 * @property {number} line The line of its string in the declaration.
 * @property {number} column
 * @property {boolean} reached
 */

/**
 * @typedef {object} PhaseCoverage
 * @property {string} title
 * @property {number} line The line of its element of `meta.phases`.
 * @property {number} column
 * @property {boolean} reached
 */

/**
 * @typedef {object} Coverage
 * @property {RoleCoverage[] | null} roles In the order readRoles gives. Null when a scenario is unread.
 * @property {ThrowSiteCoverage[] | null} throwSites In source order. Null when a scenario is unread.
 * @property {EndStateCoverage[] | null} endStates In source order. Null when a scenario is unread, or for a
 *   script with no `// @end-states` comment that declares end states.
 * @property {PhaseCoverage[] | null} phases Each element of `meta.phases` whose title is a string of 1 or more
 *   characters, in its order. Null when a scenario is unread.
 * @property {Finding[]} findings Sorted by line, then column. The contract findings of a refused script.
 * @property {UnreadScenario[]} unread Each scenario whose simulation stopped or whose script was refused, in file order.
 */

/**
 * Computes which roles, throw sites, declared end states and phases of one workflow script its scenarios
 * reach, with one finding per gap. A scenario's `expect` is not read.
 * @param {object} input
 * @param {string} input.file The script, as `validate()` names it, which each finding names.
 * @param {string | null} input.text The script's text, or null when `contractFindings` is not empty.
 * @param {Finding[]} input.contractFindings The findings of the contract check of the script.
 * @param {CoverageSimulation[]} input.runs One per scenario, in file order.
 * @returns {Coverage}
 */
export function buildCoverage({ file, text, contractFindings, runs }) {
  const unread = listUnreadScenarios(runs);

  // A count over some of the scenarios would report a gap that is none.
  if (contractFindings.length > 0 || unread.length > 0) return { roles: null, throwSites: null, endStates: null, phases: null, findings: contractFindings, unread };
  return { ...readReach(file, /** @type {string} */ (text), runs), unread };
}

/**
 * @param {string} file
 * @param {string} text A script that breaks no rule of the contract, so it parses.
 * @param {CoverageSimulation[]} runs Each with a trace that reached an end of the script's own.
 * @returns {Omit<Coverage, 'unread'>}
 */
function readReach(file, text, runs) {
  const comments = [];
  const program = parseSource(text, { ...PARSE_OPTIONS, onComment: comments });
  const { positionText, markLength } = readPositionText(text);
  const placeOffset = (offset) => findPosition(positionText, Math.max(0, offset - markLength));
  const rolePlaces = readRolePlaces(program);
  const roles = rolePlaces.map(({ role }) => role);
  const scriptThrowSites = readThrowSites(program, text);
  const { endStates: declaredEndStates, unreachedReasons, roleMarks, problems } = readCoverageDirectives(program, comments, text, scriptThrowSites, rolePlaces);
  const { checkedPhases, listedTitles } = readMetaPhases(program);
  const reach = readScenarioReach(runs, roles, scriptThrowSites);
  const placedFindings = [];
  const addFinding = (rule, message, offset) => placedFindings.push(createPlacedFinding(rule, message, file, placeOffset(offset)));
  const addSiteFinding = (rule, message, site) => placedFindings.push(createPlacedFinding(rule, message, file, site));

  for (const { rule, message, offset } of problems) addFinding(rule, message, offset);

  const roleCoverage = rolePlaces.map(({ role, labels }) => {
    const reacher = reach.roles.get(role);
    const mark = roleMarks.get(role);
    const unreachedReason = mark?.reason ?? null;
    if (reacher === undefined && mark === undefined) addFinding('role-unreached', `No scenario reaches the role "${role}"`, labels[0].valueOffset);
    if (reacher !== undefined && mark !== undefined) addFinding('role-reached', `The scenario "${reacher}" reaches the role "${role}", which a // @unreached comment marks`, mark.offset);
    return { role, ...placeOffset(labels[0].valueOffset), reached: reacher !== undefined, unreachedReason };
  });

  const throwSiteCoverage = scriptThrowSites.map((site, index) => {
    const reacher = reach.throwSites.get(index);
    const unreachedReason = unreachedReasons.get(site.line) ?? null;
    if (reacher === undefined && unreachedReason === null) addSiteFinding('throw-site-unreached', 'No scenario reaches this throw site', site);
    if (reacher !== undefined && unreachedReason !== null) addSiteFinding('throw-site-reached', `The scenario "${reacher}" reaches this throw site, which a // @unreached comment marks`, site);
    return { line: site.line, column: site.column, template: site.template, reached: reacher !== undefined, unreachedReason };
  });

  const endStateCoverage = declaredEndStates.map(({ endState, offset }) => {
    const reached = reach.endStates.has(normalizeDigits(endState));
    if (!reached) addFinding('end-state-unreached', `No scenario reaches the end state "${endState}"`, offset);
    return { endState, ...placeOffset(offset), reached };
  });

  const phaseCoverage = checkedPhases.map(({ title, offset }) => {
    const reached = reach.callPhases.has(title);
    if (!reached) addFinding('phase-unreached', `No scenario makes a call under the phase "${title}" of meta.phases`, offset);
    return { title, ...placeOffset(offset), reached };
  });
  for (const [title, user] of reach.usedPhases) {
    if (!listedTitles.has(title)) addFinding('phase-unlisted', `The scenario "${user}" uses the phase "${title}", which meta.phases does not list`, program.body[0].start);
  }

  // The sort is stable, so phase-unlisted findings of one place keep the order the scenarios first use each title in.
  const findings = placedFindings.sort((left, right) => left.line - right.line || left.column - right.column || RULE_ORDER.indexOf(left.rule) - RULE_ORDER.indexOf(right.rule));

  return {
    roles: roleCoverage,
    throwSites: throwSiteCoverage,
    endStates: declaredEndStates.length === 0 ? null : endStateCoverage,
    phases: phaseCoverage,
    findings,
  };
}

/**
 * @param {CoverageSimulation[]} runs
 * @param {string[]} roles
 * @param {import('./read-throw-sites.js').ThrowSite[]} throwSites
 * @returns {{ roles: Map<string, string>, throwSites: Map<number, string>, endStates: Set<string>, callPhases: Set<string>, usedPhases: Map<string, string> }}
 *   `roles` maps each reached role to the first scenario that reaches it, and `throwSites` maps the index of each
 *   reached site to the first scenario that reaches it. `endStates` holds each
 *   reached end state with digit runs written as `N`. `usedPhases` maps each title a call or a `phase()`
 *   invocation names to the first scenario that names it, in the order the scenarios first name them.
 */
function readScenarioReach(runs, roles, throwSites) {
  const reach = { roles: new Map(), throwSites: new Map(), endStates: new Set(), callPhases: new Set(), usedPhases: new Map() };

  for (const { name, endState, trace } of runs) {
    const { end, calls, phases, events } = trace;

    for (const call of calls) {
      const role = findRole(call.label, roles);
      if (role !== null && !reach.roles.has(role)) reach.roles.set(role, name);
      if (call.phase !== null) reach.callPhases.add(call.phase);
    }
    for (const event of events) {
      const title = event.kind === 'call' ? calls[event.index].phase : event.kind === 'phase' ? phases[event.index].title : null;
      // Claude Code 2.1.332 groups a call after phase('') under a phase titled '' (tests/fixtures/runtime/phase-probe.measured.json).
      if (title !== null && !reach.usedPhases.has(title)) reach.usedPhases.set(title, name);
    }
    if (end.kind === 'threw' && end.frames.length > 0) {
      const index = findThrowSiteIndex(end.frames[0], throwSites);
      if (index !== -1 && !reach.throwSites.has(index)) reach.throwSites.set(index, name);
    }
    if (end.kind === 'returned') {
      const label = readReturnedStatus(end.value) ?? endState;
      if (label !== null) reach.endStates.add(normalizeDigits(label));
    }
  }
  return reach;
}

/**
 * @param {SyntaxNode} program A script that breaks no rule of the contract, so its meta object holds literals alone.
 * @returns {{ checkedPhases: { title: string, offset: number }[], listedTitles: Set<string> }} `checkedPhases` holds
 *   each element of `meta.phases` whose title is a string of 1 or more characters, in its order. `listedTitles`
 *   holds the title of each element as the flow map reads it.
 */
function readMetaPhases(program) {
  const metaValue = readMetaValue(program);
  const phaseValues = metaValue !== null && Array.isArray(metaValue[PHASES_KEY]) ? metaValue[PHASES_KEY] : [];
  // readMetaValue keeps the last of two equal keys, as the runtime's object literal does.
  const phasesProperty = readMetaObject(program.body[0])?.properties.findLast((property) => readKeyName(property.key) === PHASES_KEY);
  const elements = phaseValues.length === 0 ? [] : phasesProperty.value.elements;
  const checkedPhases = phaseValues.flatMap((phase, index) => (isObject(phase) && typeof phase.title === 'string' && phase.title !== '' ? [{ title: phase.title, offset: elements[index].start }] : []));

  return { checkedPhases, listedTitles: new Set(phaseValues.map((phase) => readPhaseText(phase, 'title'))) };
}
