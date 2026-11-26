import { RUNTIME_GLOBAL_NAMES, RUNTIME_INHERITED_GLOBAL_NAMES } from './contract.js';
import { listFreeReferences } from './find-free-names.js';
import { createFinding } from './finding.js';
import { readMetaObject } from './meta-statement.js';
import { BYTE_ORDER_MARK } from './normalize-source-text.js';
import { formatSyntaxErrorReason, isStackSpaceError, PARSE_OPTIONS, parseSource } from './parse-source.js';
import { EXPORT_TYPES, findDeepestNode, isFunctionNode, isStackOverflowError, listChildNodes, listDeclaredNames, listNameChildren, listPatternIdentifiers, listPatternTargets } from './syntax-tree.js';

/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */
/** @typedef {(rule: string, message: string, offset: number, name?: string) => void} AddFinding `name` is the name the finding reports, for a rule whose fix depends on it. */
/** @typedef {{ start: number, end: number }} DefinedRange The offsets that a reference starts at or after and ends at or before. */

const SCRIPT_PARSER_DEPTH_MESSAGE = 'The script nests code deeper than the parser can read';
const SCRIPT_TREE_DEPTH_MESSAGE = 'The script nests code deeper than dwfb can read';
const LONE_CR_PATTERN = /\r(?!\n)/g;
// `&&=` writes a property only when it already holds a truthy value, so it never defines a name.
const NON_DEFINING_ASSIGNMENT = '&&=';
const IMMEDIATE_FUNCTION_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression']);
const INVOKING_METHOD_NAMES = new Set(['call', 'apply']);

// Each fact below was measured on Claude Code 2.1.332.
// The runtime refuses a script file larger than this.
export const SCRIPT_BYTE_LIMIT = 524288;
// The runtime refuses a variable name with this prefix, which its own code uses.
export const RUNTIME_RESERVED_PREFIX = '__wRg$';
// The runtime refuses a meta object that holds a key of one of these names, at any depth.
const RESERVED_META_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// The runtime checks these keys of meta and no other, each for a string of 1 or more characters.
const META_KEY_RULES = Object.freeze({ name: 'meta-name-invalid', description: 'meta-description-invalid' });
const RUNTIME_GLOBALS = new Set([...RUNTIME_GLOBAL_NAMES, ...RUNTIME_INHERITED_GLOBAL_NAMES]);

/**
 * Checks a workflow script's text against the contract of the runtime, and reads no disk.
 * After a syntax-error or source-too-deep finding it reports only script-too-large, since the parser gave no
 * syntax tree, or the tree walks overflowed on it.
 * @param {string} text The script's text as the runtime reads it.
 * @param {string} file The path each finding names.
 * @param {number} [byteCount] The size of the script file in bytes. Defaults to the size of `text` as UTF-8.
 * @returns {Finding[]} Sorted by line, then column.
 */
export function checkContract(text, file, byteCount = Buffer.byteLength(text, 'utf8')) {
  const findings = [];
  const treeFindings = [];
  const markLength = text.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  // The parser reads the raw text. A finding is placed as an editor shows it, with no byte order mark and a lone CR as a line break.
  const positionText = text.slice(markLength).replace(LONE_CR_PATTERN, '\n');
  const placeFinding = (rule, message, offset, name = null) => createFinding(rule, message, file, positionText, Math.max(0, offset - markLength), name);
  const addFinding = (rule, message, offset) => findings.push(placeFinding(rule, message, offset));
  const addTreeFinding = (rule, message, offset, name) => treeFindings.push(placeFinding(rule, message, offset, name));
  let program = null;

  findings.push(...checkScriptSize(byteCount, file));

  try {
    program = parseSource(text, PARSE_OPTIONS);
  } catch (error) {
    if (!(error instanceof SyntaxError) || typeof error.pos !== 'number') throw error;
    if (isStackSpaceError(error)) addFinding('source-too-deep', SCRIPT_PARSER_DEPTH_MESSAGE, error.pos);
    else addFinding('syntax-error', formatSyntaxErrorReason(error), error.pos);
  }

  if (program !== null) {
    try {
      checkProgram(program, addTreeFinding);
    } catch (error) {
      // Acorn parses a member or call chain in a loop, so a chain too deep for the recursive tree walks still parses.
      if (!isStackOverflowError(error)) throw error;
      treeFindings.length = 0;
      addTreeFinding('source-too-deep', SCRIPT_TREE_DEPTH_MESSAGE, findDeepestNode(program).start);
    }
  }

  return [...findings, ...treeFindings].sort((first, second) => first.line - second.line || first.column - second.column);
}

/**
 * Checks the size of a workflow script file against the runtime's limit, which the runtime of Claude Code 2.1.332
 * applies before it decodes the file. This rule alone needs no text, so it also serves a file larger than
 * READ_BYTE_LIMIT, which is too large to parse.
 * @param {number} byteCount The size of the script file in bytes.
 * @param {string} file The path the finding names.
 * @returns {Finding[]} The script-too-large finding at line 1, column 1, or none.
 */
export function checkScriptSize(byteCount, file) {
  if (byteCount <= SCRIPT_BYTE_LIMIT) return [];
  return [createFinding('script-too-large', `The script is ${formatScriptOversizeReason(byteCount)}`, file, '', 0)];
}

/**
 * @param {number} byteCount The size in bytes of a script larger than SCRIPT_BYTE_LIMIT.
 * @returns {string} The size and the runtime's limit, as a message that names the script puts them after it.
 */
export function formatScriptOversizeReason(byteCount) {
  return `${byteCount} bytes, which is more than the ${SCRIPT_BYTE_LIMIT} bytes the runtime reads`;
}

/**
 * The runtime checks the meta statement on its own and compiles only the text after it as the body, so the
 * body's rules read the statements after the meta statement, or every statement when it is missing.
 * @param {SyntaxNode} program
 * @param {AddFinding} addFinding
 */
function checkProgram(program, addFinding) {
  const metaObject = readMetaObject(program.body[0]);
  const bodyStatements = metaObject === null ? program.body : program.body.slice(1);

  if (metaObject === null) {
    addFinding('meta-not-first', 'The script does not start with export const meta = { ... }', program.body[0]?.start ?? 0);
  } else {
    checkMetaObject(metaObject, addFinding);
  }
  checkModuleStatements(bodyStatements, addFinding);
  checkBodyNodes({ ...program, body: bodyStatements }, addFinding);
}

/**
 * @param {SyntaxNode} metaObject
 * @param {AddFinding} addFinding
 */
function checkMetaObject(metaObject, addFinding) {
  const refusals = listMetaRefusals(metaObject);

  for (const { message, offset } of refusals) addFinding('meta-not-literal', message, offset);
  if (refusals.length > 0) return;

  for (const [key, rule] of Object.entries(META_KEY_RULES)) {
    // The runtime reads the object's value, where the last of two equal keys wins.
    const property = metaObject.properties.findLast((candidate) => readKeyName(candidate.key) === key);
    const value = property === undefined ? null : readStringValue(property.value);

    if (property === undefined) addFinding(rule, `The meta object has no ${key}`, metaObject.start);
    else if (value === null || value === '') addFinding(rule, `The meta object's ${key} is not a string of 1 or more characters`, property.value.start);
  }
}

/**
 * Lists each node of a meta value that the runtime refuses, outermost first, without reading below a
 * refused node.
 * @param {SyntaxNode} node
 * @returns {{ message: string, offset: number }[]}
 */
function listMetaRefusals(node) {
  const refuse = (message) => [{ message, offset: node.start }];

  switch (node.type) {
    case 'Literal':
      return [];
    case 'TemplateLiteral':
      return node.expressions.length === 0 ? [] : refuse('The meta object holds a template literal with a ${} slot');
    case 'ArrayExpression':
      return [
        ...(node.elements.includes(null) ? refuse('The meta object holds an array with a hole') : []),
        ...node.elements.filter((element) => element !== null).flatMap(listMetaRefusals),
      ];
    case 'ObjectExpression':
      return node.properties.flatMap(listPropertyRefusals);
    case 'SpreadElement':
      return refuse('The meta object holds a spread');
    case 'UnaryExpression':
      if (node.operator !== '-') return refuse(`The meta object holds the operator ${node.operator}, which is not a literal`);
      return isNumberLiteral(node.argument) ? [] : refuse('The meta object holds - before a value other than a number literal');
    case 'Identifier':
      return refuse(`The meta object reads ${node.name}, which is not a literal`);
    default:
      return refuse(`The meta object holds a node of type ${node.type}, which is not a literal`);
  }
}

/**
 * @param {SyntaxNode} property A Property or SpreadElement of an object literal.
 * @returns {{ message: string, offset: number }[]}
 */
function listPropertyRefusals(property) {
  const refuse = (message, node = property) => [{ message, offset: node.start }];
  const keyName = property.type === 'Property' && !property.computed ? readKeyName(property.key) : null;

  if (property.type === 'SpreadElement') return listMetaRefusals(property);
  if (property.computed) return refuse('The meta object holds a computed key');
  if (property.kind !== 'init') return refuse(`The meta object holds a ${property.kind} accessor`);
  if (property.method) return refuse('The meta object holds a method');

  return [
    ...(RESERVED_META_KEYS.has(keyName) ? refuse(`The meta object holds the key ${keyName}, which the runtime refuses`, property.key) : []),
    ...listMetaRefusals(property.value),
  ];
}

/**
 * @param {SyntaxNode} key A key that is not computed: a name, a keyword, a string, a number or a bigint.
 * @returns {string}
 */
function readKeyName(key) {
  return key.type === 'Identifier' ? key.name : String(key.value);
}

/**
 * @param {SyntaxNode} node
 * @returns {string | null} The string of a string literal or a template literal with no slot, else null.
 */
function readStringValue(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/**
 * @param {SyntaxNode} node
 * @returns {boolean}
 */
function isNumberLiteral(node) {
  return node.type === 'Literal' && typeof node.value === 'number';
}

/**
 * The runtime compiles the body as a function body, where an import and an export are syntax errors. An
 * export statement that declares meta is a misplaced or malformed meta statement, which meta-not-first reports.
 * @param {SyntaxNode[]} statements
 * @param {AddFinding} addFinding
 */
function checkModuleStatements(statements, addFinding) {
  for (const statement of statements) {
    const declaresMeta = statement.type === 'ExportNamedDeclaration' && statement.declaration !== null && listDeclaredNames(statement.declaration).includes('meta');

    if (statement.type === 'ImportDeclaration') addFinding('script-import', 'The script holds a static import', statement.start);
    else if (EXPORT_TYPES.has(statement.type) && !declaresMeta) addFinding('script-export', 'The script holds an export other than meta', statement.start);
  }
}

/**
 * Reports the body's code that the runtime refuses or that throws when it runs: import(), import.meta,
 * await using, a reserved name, the clock, the random source, code from strings, and a name the runtime
 * does not define. The clock, random and eval checks read only the direct forms, at a global's name.
 * @param {SyntaxNode} bodyProgram The program with the body's statements alone.
 * @param {AddFinding} addFinding
 */
function checkBodyNodes(bodyProgram, addFinding) {
  const freeReferences = listFreeReferences(bodyProgram);
  const freeNodes = new Set(freeReferences);
  const nameNodes = new WeakSet();
  const visitedNodes = new WeakSet();
  const typeofOperands = new Set();
  const assignedNodes = new Set();
  const deferredNodes = new Set();
  const immediateFunctions = new WeakSet();
  const globalThisDefinedRanges = new Map();
  const isGlobal = (node, name) => node.type === 'Identifier' && node.name === name && freeNodes.has(node);
  // A tagged template calls its tag as a function call does.
  const isGlobalCall = (node, name) => (node.type === 'CallExpression' && isGlobal(node.callee, name)) || (node.type === 'TaggedTemplateExpression' && isGlobal(node.tag, name));
  const isGlobalMember = (node, objectName, propertyName) => node.type === 'MemberExpression' && isGlobal(node.object, objectName) && readMemberName(node) === propertyName;
  const readGlobalThisName = (target) => (target.type === 'MemberExpression' && isGlobal(target.object, 'globalThis') ? readMemberName(target) : null);
  // An instance field initializer runs at each `new`, as a function body runs at each call, and a static one runs with the class.
  // A function called where it is written, such as the scope a build wraps around a module, runs at that point unless it is async or a generator.
  const isDeferredChild = (node, child) => (isFunctionNode(node) && !immediateFunctions.has(node)) || (node.type === 'PropertyDefinition' && !node.static && child === node.value);
  const visit = (node, isDeferred) => {
    // Acorn shares one node between the two names of `export { a }`.
    if (visitedNodes.has(node)) return;
    visitedNodes.add(node);
    for (const child of listNameChildren(node)) nameNodes.add(child);
    if (isDeferred && node.type === 'Identifier') deferredNodes.add(node);

    if (node.type === 'ImportExpression') addFinding('import-dynamic', 'The script holds import()', node.start);
    if (node.type === 'MetaProperty' && node.meta.name === 'import') addFinding('import-meta', 'The script holds import.meta', node.start);
    if (node.type === 'VariableDeclaration' && node.kind === 'await using') addFinding('await-using', 'The script holds an await using declaration', node.start);
    if (node.type === 'Identifier' && !nameNodes.has(node) && node.name.startsWith(RUNTIME_RESERVED_PREFIX)) {
      addFinding('runtime-reserved-name', `The script names ${node.name}, which starts with ${RUNTIME_RESERVED_PREFIX}`, node.start);
    }
    if (isGlobalMember(node, 'Date', 'now')) addFinding('clock-unavailable', 'The script uses Date.now, which throws in the runtime when called', node.start);
    if (node.type === 'NewExpression' && isGlobal(node.callee, 'Date') && node.arguments.length === 0) {
      addFinding('clock-unavailable', 'The script calls new Date() with no argument, which throws in the runtime', node.start);
    }
    if (isGlobalCall(node, 'Date')) addFinding('clock-unavailable', 'The script calls Date() without new, which throws in the runtime', node.start);
    if (isGlobalMember(node, 'Math', 'random')) addFinding('random-unavailable', 'The script uses Math.random, which throws in the runtime when called', node.start);
    if (isGlobalCall(node, 'eval')) addFinding('eval-unavailable', 'The script calls eval, which throws in the runtime', node.start);
    if (isGlobalCall(node, 'Function') || (node.type === 'NewExpression' && isGlobal(node.callee, 'Function'))) {
      addFinding('eval-unavailable', 'The script calls Function, which throws in the runtime', node.start);
    }

    if (node.type === 'UnaryExpression' && node.operator === 'typeof') typeofOperands.add(node.argument);
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      for (const identifier of listPatternIdentifiers(node.left)) assignedNodes.add(identifier);
    }
    if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left.type !== 'VariableDeclaration') {
      for (const identifier of listPatternIdentifiers(node.left)) assignedNodes.add(identifier);
    }
    const definingWrite = readDefiningWrite(node);
    for (const target of definingWrite.targets) {
      const globalThisName = readGlobalThisName(target);
      if (globalThisName !== null) globalThisDefinedRanges.set(globalThisName, [...(globalThisDefinedRanges.get(globalThisName) ?? []), definingWrite.definedRange]);
    }

    const immediateFunction = readImmediateFunction(node);
    if (immediateFunction !== null) immediateFunctions.add(immediateFunction);

    for (const child of listChildNodes(node)) visit(child, isDeferred || isDeferredChild(node, child));
  };

  visit(bodyProgram, false);
  checkUndefinedNames(freeReferences, { typeofOperands, assignedNodes, deferredNodes, globalThisDefinedRanges }, addFinding);
}

/**
 * Reads the function whose body a node runs at once: the function a call, a tagged template, `.call` or
 * `.apply` invokes where it is written, or the function `new` constructs there. An arrow function is no
 * constructor, an async body may pause at an await, and a generator body waits for next(), so none counts.
 * @param {SyntaxNode} node
 * @returns {SyntaxNode | null}
 */
function readImmediateFunction(node) {
  const isInvokingMember = node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && INVOKING_METHOD_NAMES.has(readMemberName(node.callee));
  let invoked = null;

  if (isInvokingMember) invoked = node.callee.object;
  else if (node.type === 'CallExpression') invoked = node.callee;
  else if (node.type === 'TaggedTemplateExpression') invoked = node.tag;
  else if (node.type === 'NewExpression' && node.callee.type === 'FunctionExpression') invoked = node.callee;

  if (invoked === null || !IMMEDIATE_FUNCTION_TYPES.has(invoked.type) || invoked.async || invoked.generator) return null;
  return invoked;
}

/**
 * Reports the first counted reference to each name that no declaration binds and the runtime does not
 * define. The operand of typeof does not throw, so it does not count. A name the script writes as a property
 * of globalThis is defined in the code that runs after such a write, so a reference there does not count,
 * and neither does a reference inside a function that is not called where it is written, an async or generator
 * function, or an instance field initializer, which may run after it.
 * @param {SyntaxNode[]} freeReferences In source order.
 * @param {{ typeofOperands: Set<SyntaxNode>, assignedNodes: Set<SyntaxNode>, deferredNodes: Set<SyntaxNode>, globalThisDefinedRanges: Map<string, DefinedRange[]> }} referenceFacts
 *   `globalThisDefinedRanges` maps each name to the range after each write to it as a property of globalThis.
 *   `deferredNodes` holds each identifier inside a function that is not called where it is written, an async or
 *   generator function, or an instance field initializer.
 * @param {AddFinding} addFinding
 */
function checkUndefinedNames(freeReferences, referenceFacts, addFinding) {
  const reportedNames = new Set();
  const isDefinedThroughGlobalThis = (identifier) => {
    const definedRanges = referenceFacts.globalThisDefinedRanges.get(identifier.name);
    const isInDefinedRange = (range) => identifier.start >= range.start && identifier.end <= range.end;
    return definedRanges !== undefined && (referenceFacts.deferredNodes.has(identifier) || definedRanges.some(isInDefinedRange));
  };
  const isCounted = (identifier) => !RUNTIME_GLOBALS.has(identifier.name) && !referenceFacts.typeofOperands.has(identifier) && !isDefinedThroughGlobalThis(identifier);

  for (const identifier of freeReferences.filter(isCounted)) {
    if (reportedNames.has(identifier.name)) continue;
    reportedNames.add(identifier.name);
    const verb = referenceFacts.assignedNodes.has(identifier) ? 'assigns' : 'reads';
    addFinding('global-undefined', formatUndefinedNameMessage(identifier.name, verb), identifier.start, identifier.name);
  }
}

/**
 * @param {string} name
 * @param {'reads' | 'assigns'} verb
 * @returns {string}
 */
function formatUndefinedNameMessage(name, verb) {
  if (name === 'meta') return `The script ${verb} meta, which the runtime does not define after the meta statement`;
  if (name === 'arguments') return `The script ${verb} arguments where no function binds it`;
  return `The script ${verb} ${name}, which the runtime does not define`;
}

/**
 * Reads the targets that a node writes, and creates when they are missing, with the range of code in which
 * each one holds a value. A for-in or for-of loop writes its target before each run of its body and never
 * when it visits nothing, so its range is its body.
 * @param {SyntaxNode} node
 * @returns {{ targets: SyntaxNode[], definedRange: DefinedRange }}
 */
function readDefiningWrite(node) {
  const isLoop = node.type === 'ForInStatement' || node.type === 'ForOfStatement';
  const afterNode = { start: node.end, end: Infinity };

  if (node.type === 'AssignmentExpression' && node.operator === '=') return { targets: listPatternTargets(node.left), definedRange: afterNode };
  if (node.type === 'AssignmentExpression' && node.operator !== NON_DEFINING_ASSIGNMENT) return { targets: [node.left], definedRange: afterNode };
  if (node.type === 'UpdateExpression') return { targets: [node.argument], definedRange: afterNode };
  if (isLoop && node.left.type !== 'VariableDeclaration') return { targets: listPatternTargets(node.left), definedRange: { start: node.body.start, end: node.body.end } };
  return { targets: [], definedRange: afterNode };
}

/**
 * @param {SyntaxNode} node A MemberExpression.
 * @returns {string | null} The property name of `a.b`, of `a['b']` or of a template literal with no slot in brackets, else null.
 */
function readMemberName(node) {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  return readStringValue(node.property);
}
