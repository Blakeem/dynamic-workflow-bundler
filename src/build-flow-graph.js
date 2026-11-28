import { findRole } from './find-role.js';
import { formatCallName } from './find-scripted-return.js';
import { formatHiddenCharacters } from './format-hidden-characters.js';
import { formatSimulationEnd } from './format-simulation-end.js';
import { isObject } from './is-object.js';
import { isUnfinishedTrace } from './is-unfinished-trace.js';
import { normalizeDigits } from './normalize-digits.js';
import { readItem } from './read-item.js';
import { readPhaseText } from './read-phase-text.js';
import { readReturnedStatus } from './read-returned-status.js';
import { EXPRESSION_MARK, findThrowSiteIndex } from './read-throw-sites.js';

/** @typedef {import('./simulate.js').Trace} Trace */
/** @typedef {import('./simulate.js').TraceCall} TraceCall */
/** @typedef {import('./read-throw-sites.js').ThrowSite} ThrowSite */
/** @typedef {import('./run-simulation.js').Frame} Frame */
/** @typedef {import('./run-simulation.js').Group} Group */
/** @typedef {import('./run-simulation.js').GroupStamp} GroupStamp */

const START_ID = 'S0';
const TOP_CONTEXT_KEY = 'top';
const WHITE_SPACE_RUN = /\s+/g;
const CLAUSE_SEPARATORS = [' — ', ': ', ' (', '; ', '. '];
const OPENING_BRACKETS = new Set(['(', '[', '{']);
const CLOSING_BRACKETS = new Set([')', ']', '}']);
const QUOTE_MARK = '"';
const RUNTIME_MESSAGE_LABEL = '(message built at runtime)';
const NO_MESSAGE_TEXT_LABEL = '(no message text)';
const UNLISTED_PHASE_DETAIL = '(not in meta.phases)';
const NO_LABEL_FIX = 'so give the call a label that starts with a role';
const LABEL_FIX = 'so start the label with a role';

/**
 * @typedef {object} FlowSimulation The simulation of one scenario of a scenarios file.
 * @property {string} name The scenario's name.
 * @property {string} when The words that say when the scenario's path is taken.
 * @property {string | null} endState The end state the scenario names, or null.
 * @property {Trace} trace
 */

/**
 * @typedef {object} UnmappedScenario
 * @property {string} scenario The scenario's name.
 * @property {string} reason Why the graph cannot hold the scenario's path, with no closing period.
 */

/**
 * @typedef {object} AgentNode
 * @property {string} id `a1`, `a2` and so on.
 * @property {'agent'} kind
 * @property {string} label The role.
 * @property {string} role
 * @property {string} phase The phase of the first call of the role, or ''.
 * @property {string} model The `opts.model` of the first call of the role, or ''.
 * @property {number} concurrency The most lanes that held a call of the role at once, over every scenario, 1 or more.
 *   A segment of calls gives 1, however many of its calls ran at once, and a segment of groups gives the sum over its lanes.
 */

/**
 * @typedef {object} EndNode An end state.
 * @property {string} id `t1`, `t2` and so on for an end node, `x1`, `x2` and so on for a throw node.
 * @property {'end' | 'throw'} kind
 * @property {string} label
 * @property {'returned' | 'scenario' | 'throw'} source How the first scenario that reached the node gave it:
 *   `returned` for the status of a returned object, `scenario` for a scenario's endState, `throw` for a throw site.
 * @property {number | null} line The throw site's line, or null for an end node.
 * @property {string[]} scenarios The name of each scenario that reached it.
 * @property {string[]} whens Each distinct `when` of those scenarios, in first-seen order.
 */

/**
 * @typedef {object} FlowEdge
 * @property {string} from A node id, or `S0` for the start.
 * @property {string} to A node id.
 * @property {string[]} whens Each distinct `when` of the scenarios that took the step, in first-seen order.
 * @property {boolean} back True for a step to a node that the path first reached no later than the node the step
 *   leaves, where a step out of a lane counts only the nodes that the lane or the path before its group reached.
 * @property {boolean} nextItem True for a step from one item to the next.
 * @property {number} repeat For a back edge, one more than the most times one lane took the step in one
 *   scenario. 0 for every other edge.
 */

/**
 * @typedef {object} FlowGraph The graph of every path the scenarios of a script reach, made of JSON values only.
 * @property {(AgentNode | EndNode)[]} nodes Agent nodes, then end nodes, then throw nodes.
 * @property {FlowEdge[]} edges By the position of the source in `nodes`, the start first, then of the target.
 * @property {{ id: string, title: string, detail: string, nodes: string[] }[]} phases The phases of `meta`,
 *   then each phase of an agent node that `meta` does not list.
 * @property {{ from: string, to: string, whens: string[], repeat: number }[]} loops One per back edge.
 */

/**
 * @typedef {object} PathStep One call of a trace, with the node it reaches.
 * @property {TraceCall} call
 * @property {string} role
 * @property {string} item
 */

/**
 * @typedef {object} PathEnd The end state a trace reaches.
 * @property {string} key Unique among end states and throw sites.
 * @property {'end' | 'throw'} kind
 * @property {string} label
 * @property {'returned' | 'scenario' | 'throw'} source
 * @property {number | null} line
 * @property {number} order The index of the throw site, or 0 for an end node.
 */

/**
 * @typedef {object} PathContext The top level of a trace, or one lane of a group, cut into segments.
 * @property {boolean} isLane
 * @property {PathSegment[]} segments In the order of their first members.
 */

/**
 * @typedef {{ kind: 'calls', steps: PathStep[] } | { kind: 'groups', lanes: PathContext[] }} PathSegment A run of
 *   a context's own calls, or the lanes of the groups it started that ran at the same time, by group and then by item.
 */

/**
 * @typedef {object} ContextIndex The members of each context of a trace, keyed as readContextKey gives.
 * @property {Map<string, { steps: PathStep[], groups: number[] }>} members The context's own calls, and its own
 *   groups that hold a call, each in index order.
 * @property {Map<number, number>} lastCalls By group, the index of the last call made in it or in a group nested in it.
 * @property {Map<number, Set<number>>} filledItems By group, each item whose lane holds a call, its own or nested.
 * @property {Group[]} groups
 */

/**
 * @typedef {object} SimulationPath
 * @property {FlowSimulation} simulation
 * @property {PathStep[]} steps
 * @property {PathContext} top
 * @property {PathEnd} end
 */

/**
 * @typedef {object} FoldEdge
 * @property {string} from A node key.
 * @property {string} to A node key.
 * @property {string[]} whens
 * @property {boolean} back
 * @property {boolean} nextItem
 * @property {number} repeat
 */

/**
 * @typedef {object} Fold The nodes and edges of the paths folded so far, keyed by node key.
 * @property {Map<string, { phase: string, model: string, concurrency: number }>} agents By role.
 * @property {Map<string, PathEnd & { scenarios: string[], whens: string[] }>} ends In the order paths reach them.
 * @property {Map<string, FoldEdge>} edges In the order they were made.
 */

/**
 * Folds the traces of the scenarios of one script into one graph, and reads no disk and prints nothing.
 * A scenario whose simulation stopped or whose script was refused, a call whose label starts with no role,
 * a return with no end state, a returned status that differs from the scenario's endState, a thrown error whose
 * newest frame is no throw site or that has no frame, and a call that a context made after it started a group and
 * before the last call made in that group or in a group nested in it, each make the scenario unmapped.
 * @param {object} input
 * @param {string[]} input.roles As readRoles gives them.
 * @param {ThrowSite[]} input.throwSites As readThrowSites gives them.
 * @param {unknown[]} input.phases The `phases` list of the script's meta object, or [].
 * @param {FlowSimulation[]} input.runs One per scenario, in file order.
 * @returns {{ graph: FlowGraph | null, unmapped: UnmappedScenario[] }} `graph` is null when a scenario is unmapped.
 */
export function buildFlowGraph({ roles, throwSites, phases, runs }) {
  const unmapped = [];
  const paths = [];
  /** @type {Fold} */
  const fold = { agents: new Map(), ends: new Map(), edges: new Map() };

  for (const simulation of runs) {
    const path = readSimulationPath(simulation, roles, throwSites);

    if ('reason' in path) unmapped.push({ scenario: simulation.name, reason: path.reason });
    else paths.push(path);
  }
  if (unmapped.length > 0) return { graph: null, unmapped };

  for (const path of paths) foldPath(fold, path);

  return { graph: createGraph(fold, roles, phases), unmapped };
}

/**
 * @param {FlowSimulation} simulation
 * @param {string[]} roles
 * @param {ThrowSite[]} throwSites
 * @returns {SimulationPath | { reason: string }}
 */
function readSimulationPath(simulation, roles, throwSites) {
  const { trace } = simulation;
  const steps = [];

  if (isUnfinishedTrace(trace)) return { reason: formatSimulationEnd(trace) };

  for (const call of trace.calls) {
    const role = findRole(call.label, roles);
    if (role === null) return { reason: `${formatCallName(call)} names no role of the script, ${formatRoleList(roles)}, ${call.label === null ? NO_LABEL_FIX : LABEL_FIX}` };
    steps.push({ call, role, item: readItem(/** @type {string} */ (call.label), role) });
  }
  const end = trace.end.kind === 'returned' ? readReturnedEnd(trace.end.value, simulation.endState) : readThrowEnd(trace.end, throwSites, `the script ${formatSimulationEnd(trace)}`);

  if ('reason' in end) return end;
  const contexts = indexContexts(steps, trace.groups);
  const overlap = findOverlap(steps, contexts);
  if (overlap !== null) return { reason: overlap };
  return { simulation, steps, top: cutContext(contexts, TOP_CONTEXT_KEY, false), end };
}

/**
 * @param {string[]} roles
 * @returns {string}
 */
function formatRoleList(roles) {
  if (roles.length === 0) return 'which has no role';
  return `whose roles are ${roles.map((role) => `"${formatHiddenCharacters(role)}"`).join(', ')}`;
}

/**
 * @param {unknown} value The value the script returned.
 * @param {string | null} endState
 * @returns {PathEnd | { reason: string }}
 */
function readReturnedEnd(value, endState) {
  const status = readReturnedStatus(value);
  const statusLabel = status === null ? null : normalizeDigits(status);
  const endStateLabel = endState === null ? null : normalizeDigits(endState);

  if (statusLabel === null && endStateLabel === null) return { reason: 'the script returned no status that is a non-empty string, and the scenario names no endState' };
  if (statusLabel === null) return createEnd(/** @type {string} */ (endStateLabel), 'scenario');
  if (endStateLabel !== null && endStateLabel !== statusLabel) {
    return { reason: `the script returned the status "${formatHiddenCharacters(/** @type {string} */ (status))}", which differs from the scenario's endState "${formatHiddenCharacters(/** @type {string} */ (endState))}"` };
  }
  return createEnd(statusLabel, 'returned');
}

/**
 * @param {string} label
 * @param {'returned' | 'scenario'} source
 * @returns {PathEnd}
 */
function createEnd(label, source) {
  return { key: `t:${label}`, kind: 'end', label, source, line: null, order: 0 };
}

/**
 * Only the newest frame is read, so an error that a statement of a constructor creates does not end at the
 * throw site that invoked the constructor. An error that the `new` operation of a site raises, such as
 * `Fail is not a constructor`, ends at that site, since V8 places it at the `new` keyword, measured on Node 24.
 * @param {{ frames: Frame[] }} end
 * @param {ThrowSite[]} throwSites
 * @param {string} thrown What the script threw, as a reason starts.
 * @returns {PathEnd | { reason: string }}
 */
function readThrowEnd({ frames }, throwSites, thrown) {
  const newest = frames[0];

  if (newest === undefined) return { reason: `${thrown}, and the simulation recorded no place it was created at, such as for a thrown value that is no Error, an error that the simulator threw, or an error whose stack the script read before it threw` };
  const place = `line ${newest.line}, column ${newest.column}`;
  const order = findThrowSiteIndex(newest, throwSites);
  if (order === -1) return { reason: `${thrown} at ${place}, which is no throw site` };
  const site = throwSites[order];
  const blankLabel = site.isMessageBuilt ? RUNTIME_MESSAGE_LABEL : NO_MESSAGE_TEXT_LABEL;

  return { key: `x:${order}`, kind: 'throw', label: `throw: ${readFirstClause(site.template, blankLabel)}`, source: 'throw', line: site.line, order };
}

/**
 * Cuts a message before its first clause separator outside brackets, double quotes and the EXPRESSION_MARK
 * of an expression. With no such separator in a message whose brackets or quotes do not balance, cuts before
 * the earliest separator past the start and outside the EXPRESSION_MARK of an expression.
 * @param {string} message
 * @param {string} blankLabel What a message of white space alone gives.
 * @returns {string}
 */
function readFirstClause(message, blankLabel) {
  const text = message.replace(WHITE_SPACE_RUN, ' ').trim();
  let depth = 0;
  let isInQuote = false;
  let isBalanced = true;
  let earliestSeparator = -1;

  if (text === '') return blankLabel;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const isSeparator = CLAUSE_SEPARATORS.some((separator) => text.startsWith(separator, index));

    if (text.startsWith(EXPRESSION_MARK, index)) {
      index += EXPRESSION_MARK.length - 1;
      continue;
    }
    if (isSeparator && index > 0 && earliestSeparator === -1) earliestSeparator = index;

    if (isInQuote) {
      if (character === QUOTE_MARK) isInQuote = false;
    } else if (depth === 0 && isSeparator) {
      return text.slice(0, index);
    } else if (character === QUOTE_MARK) {
      isInQuote = true;
    } else if (OPENING_BRACKETS.has(character)) {
      depth += 1;
    } else if (CLOSING_BRACKETS.has(character)) {
      isBalanced &&= depth > 0;
      depth = Math.max(depth - 1, 0);
    }
  }
  if (isBalanced && depth === 0 && !isInQuote) return text;

  return earliestSeparator === -1 ? text : text.slice(0, earliestSeparator);
}

/**
 * @param {PathStep[]} steps
 * @param {Group[]} groups The groups of the trace.
 * @returns {ContextIndex}
 */
function indexContexts(steps, groups) {
  const members = new Map();
  const lastCalls = new Map();
  const filledItems = new Map();

  for (const step of steps) {
    readMembers(members, readContextKey(step.call.group)).steps.push(step);
    for (let stamp = step.call.group; stamp !== null; stamp = groups[stamp.group].parent) {
      if (!filledItems.has(stamp.group)) filledItems.set(stamp.group, new Set());
      filledItems.get(stamp.group).add(stamp.item);
      lastCalls.set(stamp.group, step.call.index);
    }
  }
  groups.forEach((group, groupIndex) => {
    if (lastCalls.has(groupIndex)) readMembers(members, readContextKey(group.parent)).groups.push(groupIndex);
  });

  return { members, lastCalls, filledItems, groups };
}

/**
 * @param {ContextIndex['members']} members
 * @param {string} contextKey
 * @returns {{ steps: PathStep[], groups: number[] }} The members of the context, added empty when missing.
 */
function readMembers(members, contextKey) {
  if (!members.has(contextKey)) members.set(contextKey, { steps: [], groups: [] });
  return members.get(contextKey);
}

/**
 * The stage of a stamp is left out, so each item of a pipeline() is one lane across its stages.
 * @param {Readonly<Pick<GroupStamp, 'group' | 'item'>> | null} stamp A call's group, or a group's parent.
 * @returns {string}
 */
function readContextKey(stamp) {
  return stamp === null ? TOP_CONTEXT_KEY : JSON.stringify([stamp.group, stamp.item]);
}

/**
 * @param {PathStep[]} steps
 * @param {ContextIndex} contexts
 * @returns {string | null} The reason for the first call that a context made after it started a group and before
 *   the last call made in that group or in a group nested in it, or null for none. The reason names the group of the
 *   next call made in that group, so a group nested in it that the context's own group left running is named too.
 */
function findOverlap(steps, { members, lastCalls, groups }) {
  for (const { call } of steps) {
    const ownGroups = members.get(readContextKey(call.group)).groups;
    const runningGroup = ownGroups.find((groupIndex) => groups[groupIndex].beforeCall <= call.index && call.index < lastCalls.get(groupIndex));
    let runningStep = null;
    let innerGroup = -1;
    let groupName = '';

    if (runningGroup === undefined) continue;
    runningStep = /** @type {PathStep} */ (steps.find((step) => step.call.index > call.index && isStampInGroup(step.call.group, runningGroup, groups)));
    innerGroup = /** @type {GroupStamp} */ (runningStep.call.group).group;
    groupName = innerGroup === runningGroup ? `group ${runningGroup}` : `group ${innerGroup}, started inside group ${runningGroup}`;

    return `${formatContextName(call.group)} made ${formatCallName(call)} before the last call made in ${groupName}, which it started, so the flow map cannot place it`;
  }
  return null;
}

/**
 * @param {Readonly<GroupStamp> | null} stamp A call's group.
 * @param {number} groupIndex
 * @param {Group[]} groups
 * @returns {boolean} True when the stamp's group is that group or is nested in it.
 */
function isStampInGroup(stamp, groupIndex, groups) {
  for (let lane = stamp; lane !== null; lane = groups[lane.group].parent) {
    if (lane.group === groupIndex) return true;
  }
  return false;
}

/**
 * @param {Readonly<GroupStamp> | null} stamp
 * @returns {string}
 */
function formatContextName(stamp) {
  return stamp === null ? 'the top level' : `the lane of item ${stamp.item} of group ${stamp.group}`;
}

/**
 * Orders the members of one context by where they start, where a group sits before the call of the number of its
 * beforeCall and two groups of one beforeCall go by index, and cuts them into segments. findOverlap leaves no
 * scenario in which a call and a group tie, since that call falls before the group's last call. A group joins the group
 * segment before it when its beforeCall is at most the index of the last call made in a group of that segment.
 * @param {ContextIndex} contexts
 * @param {string} contextKey
 * @param {boolean} isLane
 * @returns {PathContext}
 */
function cutContext(contexts, contextKey, isLane) {
  const { steps, groups: groupIndexes } = contexts.members.get(contextKey) ?? { steps: [], groups: [] };
  const callMembers = steps.map((step) => ({ start: step.call.index, isGroup: false, order: step.call.index, step }));
  const groupMembers = groupIndexes.map((groupIndex) => ({ start: contexts.groups[groupIndex].beforeCall, isGroup: true, order: groupIndex, step: null }));
  const members = [...callMembers, ...groupMembers].sort((left, right) => left.start - right.start || Number(right.isGroup) - Number(left.isGroup) || left.order - right.order);
  /** @type {({ kind: 'calls', steps: PathStep[] } | { kind: 'groups', groupIndexes: number[], lastCall: number })[]} */
  const cuts = [];

  for (const member of members) {
    const last = cuts.at(-1);

    if (member.step !== null) {
      if (last?.kind === 'calls') last.steps.push(member.step);
      else cuts.push({ kind: 'calls', steps: [member.step] });
      continue;
    }
    const lastCall = /** @type {number} */ (contexts.lastCalls.get(member.order));
    if (last?.kind === 'groups' && member.start <= last.lastCall) {
      last.groupIndexes.push(member.order);
      last.lastCall = Math.max(last.lastCall, lastCall);
    } else {
      cuts.push({ kind: 'groups', groupIndexes: [member.order], lastCall });
    }
  }

  return { isLane, segments: cuts.map((cut) => (cut.kind === 'calls' ? cut : { kind: 'groups', lanes: cutLanes(contexts, cut.groupIndexes) })) };
}

/**
 * @param {ContextIndex} contexts
 * @param {number[]} groupIndexes The groups of one segment, in index order.
 * @returns {PathContext[]} One per item that holds a call, by group and then by item.
 */
function cutLanes(contexts, groupIndexes) {
  return groupIndexes.flatMap((group) => {
    const items = [.../** @type {Set<number>} */ (contexts.filledItems.get(group))].sort((left, right) => left - right);

    return items.map((item) => cutContext(contexts, readContextKey({ group, item }), true));
  });
}

/**
 * Adds the nodes and edges of one path to the fold.
 * @param {Fold} fold
 * @param {SimulationPath} path
 */
function foldPath(fold, { simulation, steps, top, end }) {
  /** @type {ContextFold | null} */
  let topFold = null;

  for (const step of steps) addAgent(fold, step);
  addEnd(fold, end, simulation);

  topFold = foldContext(fold, top, { simulation, reachedBefore: new Map(), chainLength: 0, walkCounts: new Map() });
  for (const [role, count] of topFold.concurrency) {
    const agent = fold.agents.get(role);
    agent.concurrency = Math.max(agent.concurrency, count);
  }

  if (topFold.exits.length === 0) addEdge(fold, { from: START_ID, to: end.key, when: simulation.when, back: false, nextItem: false, repeat: 0 });
  else for (const exit of topFold.exits) addEdge(fold, { from: agentKey(exit.role), to: end.key, when: simulation.when, back: false, nextItem: false, repeat: 0 });
}

/**
 * @param {Fold} fold
 * @param {PathStep} step
 */
function addAgent(fold, { call, role }) {
  if (fold.agents.has(role)) return;
  const model = isObject(call.opts) && typeof call.opts.model === 'string' ? call.opts.model : '';

  fold.agents.set(role, { phase: call.phase ?? '', model, concurrency: 1 });
}

/**
 * @param {Fold} fold
 * @param {PathEnd} end
 * @param {FlowSimulation} simulation
 */
function addEnd(fold, end, simulation) {
  if (!fold.ends.has(end.key)) fold.ends.set(end.key, { ...end, scenarios: [], whens: [] });
  const node = fold.ends.get(end.key);

  node.scenarios.push(simulation.name);
  if (!node.whens.includes(simulation.when)) node.whens.push(simulation.when);
}

/**
 * @typedef {object} FoldInput
 * @property {FlowSimulation} simulation
 * @property {Map<string, number>} reachedBefore The roles that the segments before this unit reached, in its own context
 *   and in every enclosing one, each with the chain length before the call that first reached it along the context chain.
 * @property {number} chainLength The count of calls along the context chain before this unit, where a segment of groups
 *   counts the calls of its longest lane. It ignores the order in which sibling lanes made their calls.
 * @property {Map<string, number>} walkCounts
 */

/**
 * @typedef {object} ContextFold What folding a context or one of its segments gives the unit around it.
 * @property {PathStep[]} entries
 * @property {PathStep[]} exits Empty for a context with no segment.
 * @property {Map<PathStep, Map<string, number>>} exitReached By exit, the roles reached along the context chain of the
 *   exit's own lane up to it, so a join from one lane never counts a role that only a sibling lane reached.
 * @property {Map<string, number>} reached The roles reached before the unit and in it, each with the chain length before
 *   the call that first reached it along the context chain.
 * @property {number} chainLength The chain length after the unit.
 * @property {Map<string, number>} concurrency By role, the most lanes that held a call of the role at once in the unit.
 */

/**
 * Folds the segments of one context in order and joins each to the one before it. The first segment of the top
 * level joins the start, and the first segment of a lane joins nothing, since the segment that holds the lane joins it.
 * @param {Fold} fold
 * @param {PathContext} context
 * @param {FoldInput} input
 * @returns {ContextFold}
 */
function foldContext(fold, { isLane, segments }, input) {
  const concurrency = new Map();
  let reached = input.reachedBefore;
  let { chainLength } = input;
  /** @type {PathStep[]} */
  let entries = [];
  /** @type {PathStep[]} */
  let exits = [];
  /** @type {Map<PathStep, Map<string, number>>} */
  let exitReached = new Map();

  segments.forEach((segment, position) => {
    const segmentInput = { ...input, reachedBefore: reached, chainLength };
    const segmentFold = segment.kind === 'calls' ? foldCallSegment(fold, segment.steps, isLane, segmentInput) : foldGroupSegment(fold, segment.lanes, segmentInput);

    if (position > 0 || !isLane) foldJoins(fold, { ...segmentInput, exits: position === 0 ? null : exits, exitReached, entries: segmentFold.entries });
    if (position === 0) entries = segmentFold.entries;
    exits = segmentFold.exits;
    exitReached = segmentFold.exitReached;
    reached = segmentFold.reached;
    chainLength = segmentFold.chainLength;
    for (const [role, count] of segmentFold.concurrency) concurrency.set(role, Math.max(concurrency.get(role) ?? 0, count));
  });

  return { entries, exits, exitReached, reached, chainLength, concurrency };
}

/**
 * Adds an edge from each call of a segment to the next.
 * @param {Fold} fold
 * @param {PathStep[]} steps The calls of one segment, one or more.
 * @param {boolean} isLane True when the segment's context is a lane, whose calls make no next-item edge.
 * @param {FoldInput} input
 * @returns {ContextFold}
 */
function foldCallSegment(fold, steps, isLane, { simulation, reachedBefore, chainLength, walkCounts }) {
  const reached = new Map(reachedBefore);
  const concurrency = new Map();
  const lastStep = /** @type {PathStep} */ (steps.at(-1));

  steps.forEach((step, position) => {
    if (position > 0) {
      const previous = steps[position - 1];
      const nextItem = !isLane && isItemChange(previous.item, step.item);
      const back = !nextItem && isBackStep(previous.role, step.role, reached);
      const repeat = back ? countWalk(walkCounts, previous, step) + 1 : 0;

      addEdge(fold, { from: agentKey(previous.role), to: agentKey(step.role), when: simulation.when, back, nextItem, repeat });
    }
    if (!reached.has(step.role)) reached.set(step.role, chainLength + position);
    concurrency.set(step.role, 1);
  });

  return { entries: [steps[0]], exits: [lastStep], exitReached: new Map([[lastStep, reached]]), reached, chainLength: chainLength + steps.length, concurrency };
}

/**
 * Folds each lane of a segment of groups as a context. No lane reaches the roles of another.
 * @param {Fold} fold
 * @param {PathContext[]} lanes
 * @param {FoldInput} input
 * @returns {ContextFold}
 */
function foldGroupSegment(fold, lanes, input) {
  const reached = new Map(input.reachedBefore);
  const concurrency = new Map();
  const entries = [];
  const exits = [];
  const exitReached = new Map();
  let { chainLength } = input;

  for (const lane of lanes) {
    const laneFold = foldContext(fold, lane, input);

    entries.push(...laneFold.entries);
    exits.push(...laneFold.exits);
    for (const [exit, exitRoles] of laneFold.exitReached) exitReached.set(exit, exitRoles);
    for (const [role, laneStart] of laneFold.reached) reached.set(role, Math.min(reached.get(role) ?? laneStart, laneStart));
    chainLength = Math.max(chainLength, laneFold.chainLength);
    for (const [role, count] of laneFold.concurrency) concurrency.set(role, (concurrency.get(role) ?? 0) + count);
  }

  return { entries, exits, exitReached, reached, chainLength, concurrency };
}

/**
 * Adds an edge from each exit of the segment before to each entry of this one, or from the start.
 * @param {Fold} fold
 * @param {{ simulation: FlowSimulation, exits: PathStep[] | null, exitReached: Map<PathStep, Map<string, number>>,
 *   entries: PathStep[], walkCounts: Map<string, number> }} input
 */
function foldJoins(fold, { simulation, exits, exitReached, entries, walkCounts }) {
  // A back step from one source lane counts once per pair of segments, however many lanes it enters.
  const walkedKeys = new Map();

  if (exits === null) {
    for (const entry of entries) addEdge(fold, { from: START_ID, to: agentKey(entry.role), when: simulation.when, back: false, nextItem: false, repeat: 0 });
    return;
  }
  for (const exit of exits) {
    for (const entry of entries) {
      const isGroupedPair = exit.call.group !== null && entry.call.group !== null;
      const nextItem = !isGroupedPair && isItemChange(exit.item, entry.item);
      const back = !nextItem && isBackStep(exit.role, entry.role, /** @type {Map<string, number>} */ (exitReached.get(exit)));
      const walkKey = createWalkKey(exit, entry);

      if (back && !walkedKeys.has(walkKey)) walkedKeys.set(walkKey, countWalk(walkCounts, exit, entry) + 1);
      addEdge(fold, { from: agentKey(exit.role), to: agentKey(entry.role), when: simulation.when, back, nextItem, repeat: back ? walkedKeys.get(walkKey) : 0 });
    }
  }
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean} True when both items name an item and they differ.
 */
function isItemChange(from, to) {
  return from !== '' && to !== '' && from !== to;
}

/**
 * @param {string} sourceRole
 * @param {string} targetRole
 * @param {Map<string, number>} reached Each role reached before the step, with the chain length before the call that
 *   first reached it along the context chain.
 * @returns {boolean} True when the target was reached before and first reached along the context chain no later than
 *   the source.
 */
function isBackStep(sourceRole, targetRole, reached) {
  return reached.has(targetRole) && /** @type {number} */ (reached.get(targetRole)) <= /** @type {number} */ (reached.get(sourceRole));
}

/**
 * @param {PathStep} source
 * @param {PathStep} target
 * @returns {string} The source's lane, the source's role and the target's role.
 */
function createWalkKey(source, target) {
  const { group } = source.call;
  const lane = group === null ? ['item', source.item] : ['group', group.group, group.item];

  return JSON.stringify([lane, source.role, target.role]);
}

/**
 * @param {Map<string, number>} walkCounts
 * @param {PathStep} source
 * @param {PathStep} target
 * @returns {number} The count of walks of the step in the source's lane, this one included.
 */
function countWalk(walkCounts, source, target) {
  const walkKey = createWalkKey(source, target);
  const count = (walkCounts.get(walkKey) ?? 0) + 1;

  walkCounts.set(walkKey, count);
  return count;
}

/**
 * @param {string} role
 * @returns {string}
 */
function agentKey(role) {
  return `a:${role}`;
}

/**
 * Merges an edge into the edge of the same source, target and nextItem.
 * @param {Fold} fold
 * @param {{ from: string, to: string, when: string, back: boolean, nextItem: boolean, repeat: number }} step
 */
function addEdge(fold, { from, to, when, back, nextItem, repeat }) {
  const edgeKey = JSON.stringify([nextItem, from, to]);
  const edge = fold.edges.get(edgeKey);

  if (edge === undefined) {
    fold.edges.set(edgeKey, { from, to, whens: [when], back, nextItem, repeat });
    return;
  }
  if (!edge.whens.includes(when)) edge.whens.push(when);
  edge.back ||= back;
  edge.repeat = Math.max(edge.repeat, repeat);
}

/**
 * @param {Fold} fold
 * @param {string[]} roles
 * @param {unknown[]} metaPhases
 * @returns {FlowGraph}
 */
function createGraph(fold, roles, metaPhases) {
  const ends = [...fold.ends.values()];
  const agentEntries = roles.filter((role) => fold.agents.has(role)).map((role, index) => ({ key: agentKey(role), node: createAgentNode(role, fold.agents.get(role), `a${index + 1}`) }));
  const endEntries = ends.filter((end) => end.kind === 'end').map((end, index) => ({ key: end.key, node: createEndNode(end, `t${index + 1}`) }));
  const throwEntries = ends
    .filter((end) => end.kind === 'throw')
    .sort((left, right) => left.order - right.order)
    .map((end, index) => ({ key: end.key, node: createEndNode(end, `x${index + 1}`) }));
  const nodeEntries = [...agentEntries, ...endEntries, ...throwEntries];
  const idByKey = new Map([[START_ID, START_ID], ...nodeEntries.map(({ key, node }) => [key, node.id])]);
  const rankByKey = new Map([[START_ID, -1], ...nodeEntries.map(({ key }, rank) => [key, rank])]);
  // The sort is stable, so edges of one source and target keep the order they were made in.
  const edges = [...fold.edges.values()]
    .sort((left, right) => rankByKey.get(left.from) - rankByKey.get(right.from) || rankByKey.get(left.to) - rankByKey.get(right.to))
    .map((edge) => ({ ...edge, from: idByKey.get(edge.from), to: idByKey.get(edge.to), whens: [...edge.whens] }));
  const loops = edges.filter((edge) => edge.back).map(({ from, to, whens, repeat }) => ({ from, to, whens: [...whens], repeat }));
  const agentNodes = agentEntries.map(({ node }) => node);

  return { nodes: nodeEntries.map(({ node }) => node), edges, phases: createPhases(metaPhases, agentNodes), loops };
}

/**
 * @param {string} role
 * @param {{ phase: string, model: string, concurrency: number }} agent
 * @param {string} id
 * @returns {AgentNode}
 */
function createAgentNode(role, { phase, model, concurrency }, id) {
  return { id, kind: 'agent', label: role, role, phase, model, concurrency };
}

/**
 * @param {PathEnd & { scenarios: string[], whens: string[] }} end
 * @param {string} id
 * @returns {EndNode}
 */
function createEndNode({ kind, label, source, line, scenarios, whens }, id) {
  return { id, kind, label, source, line, scenarios: [...scenarios], whens: [...whens] };
}

/**
 * @param {unknown[]} metaPhases
 * @param {AgentNode[]} agentNodes In node order.
 * @returns {FlowGraph['phases']}
 */
function createPhases(metaPhases, agentNodes) {
  const phases = metaPhases.map((phase, index) => ({ id: `p${index + 1}`, title: readPhaseText(phase, 'title'), detail: readPhaseText(phase, 'detail'), nodes: [] }));

  // A node of no phase joins no phase, though a meta phase with no title reads as the title ''.
  for (const node of agentNodes.filter(({ phase }) => phase !== '')) {
    const phase = phases.find((candidate) => candidate.title === node.phase);

    if (phase !== undefined) phase.nodes.push(node.id);
    else phases.push({ id: `p${phases.length + 1}`, title: node.phase, detail: UNLISTED_PHASE_DETAIL, nodes: [node.id] });
  }
  return phases;
}
