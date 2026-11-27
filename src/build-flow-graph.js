import { formatCallName } from './find-scripted-return.js';
import { formatHiddenCharacters } from './format-hidden-characters.js';
import { formatSimulationEnd } from './format-simulation-end.js';
import { isObject } from './is-object.js';
import { LABEL_SEPARATOR } from './read-roles.js';
import { EXPRESSION_MARK } from './read-throw-sites.js';

/** @typedef {import('./simulate.js').Trace} Trace */
/** @typedef {import('./simulate.js').TraceCall} TraceCall */
/** @typedef {import('./read-throw-sites.js').ThrowSite} ThrowSite */

const START_ID = 'S0';
const DIGIT_RUN = /\d+/g;
const ROUND_MARKER_END = new RegExp(`${LABEL_SEPARATOR}+r\\d+$`);
const LEADING_SEPARATORS = new RegExp(`^${LABEL_SEPARATOR}+`);
const WHITE_SPACE_RUN = /\s+/g;
const CLAUSE_SEPARATORS = [' — ', ': ', ' (', '; ', '. '];
const OPENING_BRACKETS = new Set(['(', '[', '{']);
const CLOSING_BRACKETS = new Set([')', ']', '}']);
const QUOTE_MARK = '"';
const RUNTIME_MESSAGE_LABEL = '(message built at runtime)';
const NO_MESSAGE_TEXT_LABEL = '(no message text)';
const UNLISTED_PHASE_DETAIL = '(not in meta.phases)';

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
 * @property {number} concurrency The most lanes of one grouped segment that held a call of the role, over every
 *   segment and scenario, 1 or more.
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
 * @property {boolean} back True for a step back to a node that the path reached before.
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
 * @typedef {object} SimulationPath
 * @property {FlowSimulation} simulation
 * @property {PathStep[]} steps
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
 * a return with no end state, a returned status that differs from the scenario's endState, a thrown message
 * that starts with the fixed text of no throw site, and one that only several throw sites with no fixed text
 * match each make the scenario unmapped.
 * A trace records only the innermost group of a call, so two groups that run at the same time, or one
 * started inside another's lane, fold as segments one after the other.
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

  if (trace.end.kind === 'stopped' || trace.end.kind === 'refused') return { reason: formatSimulationEnd(trace) };

  for (const call of trace.calls) {
    const role = findRole(call.label, roles);
    if (role === null) return { reason: `${formatCallName(call)} names no role of the script, ${formatRoleList(roles)}` };
    steps.push({ call, role, item: readItem(/** @type {string} */ (call.label), role) });
  }
  const end = trace.end.kind === 'returned' ? readReturnedEnd(trace.end.value, simulation.endState) : readThrowEnd(trace.end, throwSites);

  if ('reason' in end) return end;
  return { simulation, steps, end };
}

/**
 * @param {string | null} label
 * @param {string[]} roles
 * @returns {string | null} The longest role the label starts with, or null.
 */
function findRole(label, roles) {
  if (label === null) return null;
  const matches = roles.filter((role) => label.startsWith(role));

  return matches.length === 0 ? null : matches.reduce((longest, role) => (role.length > longest.length ? role : longest));
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
 * @param {string} label
 * @param {string} role A role the label starts with.
 * @returns {string} The label after the role, with no round marker at its end and no separator at its start.
 */
function readItem(label, role) {
  return label.slice(role.length).replace(ROUND_MARKER_END, '').replace(LEADING_SEPARATORS, '').trim();
}

/**
 * @param {unknown} value The value the script returned.
 * @param {string | null} endState
 * @returns {PathEnd | { reason: string }}
 */
function readReturnedEnd(value, endState) {
  const status = isObject(value) && typeof value.status === 'string' && value.status !== '' ? value.status : null;
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
 * Of two sites with the same longest prefix that is not empty, the first in source order wins.
 * @param {{ name: string, message: string }} end
 * @param {ThrowSite[]} throwSites
 * @returns {PathEnd | { reason: string }}
 */
function readThrowEnd({ name, message }, throwSites) {
  const thrown = `the script threw ${formatHiddenCharacters(name)} with the message "${formatHiddenCharacters(message)}"`;
  const candidates = throwSites.map((site, order) => ({ site, order })).filter(({ site }) => message.startsWith(site.prefix));

  if (candidates.length === 0) return { reason: `${thrown}, which starts with the fixed text of no throw site` };
  const best = candidates.reduce((longest, candidate) => (candidate.site.prefix.length > longest.site.prefix.length ? candidate : longest));
  if (best.site.prefix === '' && candidates.length > 1) {
    const lines = candidates.map(({ site }) => site.line).join(', ');
    return { reason: `${thrown}, which starts with the fixed text of no throw site, and the throw sites at lines ${lines} each give a message with no fixed start` };
  }
  const { site, order } = best;

  const blankLabel = site.isMessageBuilt ? RUNTIME_MESSAGE_LABEL : NO_MESSAGE_TEXT_LABEL;

  return { key: `x:${order}`, kind: 'throw', label: `throw: ${readFirstClause(site.template, blankLabel)}`, source: 'throw', line: site.line, order };
}

/**
 * @param {string} label
 * @returns {string}
 */
function normalizeDigits(label) {
  return label.replace(DIGIT_RUN, 'N');
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
 * Adds the nodes and edges of one path to the fold.
 * @param {Fold} fold
 * @param {SimulationPath} path
 */
function foldPath(fold, { simulation, steps, end }) {
  const firstSeen = new Map();
  const walkCounts = new Map();
  const segments = cutSegments(steps);
  let reached = new Set();
  /** @type {PathStep[] | null} */
  let exits = null;

  steps.forEach((step, position) => {
    if (!firstSeen.has(step.role)) firstSeen.set(step.role, position);
    addAgent(fold, step);
  });
  addEnd(fold, end, simulation);

  for (const segment of segments) {
    const reachedBefore = reached;

    reached = new Set(reachedBefore);
    for (const lane of segment.lanes) foldLane(fold, { simulation, lane, isGrouped: segment.isGrouped, reachedBefore, reached, firstSeen, walkCounts });
    foldJoins(fold, { simulation, exits, entries: segment.lanes.map((lane) => lane[0]), reachedBefore, firstSeen, walkCounts });
    if (segment.isGrouped) countConcurrency(fold, segment.lanes);
    exits = segment.lanes.map((lane) => lane[lane.length - 1]);
  }

  if (exits === null) addEdge(fold, { from: START_ID, to: end.key, when: simulation.when, back: false, nextItem: false, repeat: 0 });
  else for (const exit of exits) addEdge(fold, { from: agentKey(exit.role), to: end.key, when: simulation.when, back: false, nextItem: false, repeat: 0 });
}

/**
 * @param {PathStep[]} steps
 * @returns {{ isGrouped: boolean, lanes: PathStep[][] }[]} One segment per longest run of steps that are all
 *   ungrouped or all in one group. An ungrouped segment is one lane, and a grouped one has one lane per item, by item.
 */
function cutSegments(steps) {
  const segments = [];

  for (const step of steps) {
    const group = step.call.group === null ? null : step.call.group.group;
    const last = segments.at(-1);

    if (last === undefined || last.group !== group) segments.push({ group, steps: [step] });
    else last.steps.push(step);
  }

  return segments.map(({ group, steps: segmentSteps }) => ({ isGrouped: group !== null, lanes: group === null ? [segmentSteps] : cutLanes(segmentSteps) }));
}

/**
 * @param {PathStep[]} steps Steps of one group.
 * @returns {PathStep[][]}
 */
function cutLanes(steps) {
  const lanes = new Map();

  for (const step of steps) {
    const item = /** @type {NonNullable<TraceCall['group']>} */ (step.call.group).item;
    if (!lanes.has(item)) lanes.set(item, []);
    lanes.get(item).push(step);
  }

  return [...lanes.keys()].sort((left, right) => left - right).map((item) => lanes.get(item));
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
 * @typedef {object} LaneInput
 * @property {FlowSimulation} simulation
 * @property {PathStep[]} lane
 * @property {boolean} isGrouped
 * @property {Set<string>} reachedBefore The roles the segments before this one reached.
 * @property {Set<string>} reached The roles reached so far, which this lane adds to.
 * @property {Map<string, number>} firstSeen The position of each role's first call in the trace.
 * @property {Map<string, number>} walkCounts
 */

/**
 * Adds an edge from each step of a lane to the next.
 * @param {Fold} fold
 * @param {LaneInput} input
 */
function foldLane(fold, { simulation, lane, isGrouped, reachedBefore, reached, firstSeen, walkCounts }) {
  const laneReached = new Set(reachedBefore);

  lane.forEach((step, position) => {
    if (position > 0) {
      const previous = lane[position - 1];
      const nextItem = !isGrouped && isItemChange(previous.item, step.item);
      const back = !nextItem && isBackStep(previous.role, step.role, laneReached, firstSeen);
      const repeat = back ? countWalk(walkCounts, previous, step) + 1 : 0;

      addEdge(fold, { from: agentKey(previous.role), to: agentKey(step.role), when: simulation.when, back, nextItem, repeat });
    }
    laneReached.add(step.role);
    reached.add(step.role);
  });
}

/**
 * Adds an edge from each exit of the segment before to each entry of this one, or from the start.
 * @param {Fold} fold
 * @param {{ simulation: FlowSimulation, exits: PathStep[] | null, entries: PathStep[], reachedBefore: Set<string>,
 *   firstSeen: Map<string, number>, walkCounts: Map<string, number> }} input
 */
function foldJoins(fold, { simulation, exits, entries, reachedBefore, firstSeen, walkCounts }) {
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
      const back = !nextItem && isBackStep(exit.role, entry.role, reachedBefore, firstSeen);
      const walkKey = createWalkKey(exit, entry);

      if (back && !walkedKeys.has(walkKey)) walkedKeys.set(walkKey, countWalk(walkCounts, exit, entry) + 1);
      addEdge(fold, { from: agentKey(exit.role), to: agentKey(entry.role), when: simulation.when, back, nextItem, repeat: back ? walkedKeys.get(walkKey) : 0 });
    }
  }
}

/**
 * @param {Fold} fold
 * @param {PathStep[][]} lanes The lanes of one group.
 */
function countConcurrency(fold, lanes) {
  const laneCounts = new Map();

  for (const lane of lanes) {
    for (const role of new Set(lane.map((step) => step.role))) laneCounts.set(role, (laneCounts.get(role) ?? 0) + 1);
  }
  for (const [role, count] of laneCounts) {
    const agent = fold.agents.get(role);
    agent.concurrency = Math.max(agent.concurrency, count);
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
 * @param {Set<string>} reachedBefore
 * @param {Map<string, number>} firstSeen
 * @returns {boolean} True when the target was reached before and first reached no later than the source.
 */
function isBackStep(sourceRole, targetRole, reachedBefore, firstSeen) {
  return reachedBefore.has(targetRole) && firstSeen.get(targetRole) <= firstSeen.get(sourceRole);
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

/**
 * @param {unknown} phase One element of the meta object's phases list.
 * @param {'title' | 'detail'} key
 * @returns {string} The key's value as text, or '' for a phase that is not an object or lacks the key.
 */
function readPhaseText(phase, key) {
  return isObject(phase) && phase[key] !== undefined && phase[key] !== null ? String(phase[key]) : '';
}
