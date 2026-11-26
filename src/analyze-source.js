import { parse, tokenizer, tokTypes } from 'acorn';
import { createFinding } from './finding.js';
import { findExportAssignments } from './find-export-assignments.js';
import { findFreeNames } from './find-free-names.js';
import { isFunctionNode, listChildNodes, listDeclaredNames, listNameChildren, listTopLevelNames } from './syntax-tree.js';

/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */

/**
 * @typedef {object} ImportBinding
 * @property {string} imported An export name, or `*` for a namespace import.
 * @property {string} local
 * @property {number} offset The offset of the imported name.
 */

/**
 * @typedef {object} ImportRecord
 * @property {string} specifier
 * @property {number} offset The offset of the specifier.
 * @property {ImportBinding[]} bindings Empty for an import that only evaluates the module.
 */

/**
 * @typedef {object} ExportRecord
 * @property {string} exported
 * @property {string} local
 */

/**
 * @typedef {object} Edit
 * @property {number} start
 * @property {number} end
 * @property {string} text Holds every line break of the text it replaces, so line numbers stay fixed.
 */

/**
 * @typedef {object} FreeName
 * @property {string} name
 * @property {number} offset The offset of the name's first reference.
 */

/**
 * @typedef {object} SourceAnalysis
 * @property {Finding[]} findings In source order.
 * @property {ImportRecord[]} imports The imports that name a module, in source order.
 * @property {ExportRecord[]} exports
 * @property {Edit[]} edits In source order, with no overlap.
 * @property {number | null} metaEnd For an entry, the offset just after its meta statement.
 * @property {string[]} topLevelNames For an entry, the names its top level declares. Empty for a module.
 * @property {FreeName[]} freeNames For a module, the names it reads that none of its scopes declares, in
 *   source order. Empty for an entry.
 */

export const RESERVED_PREFIX = '__dwfb_';
export const DEFAULT_EXPORT_LOCAL = `${RESERVED_PREFIX}default`;
/** The globals that the scope code from formatScope in join-modules.js reads. */
export const SCOPE_GLOBALS = Object.freeze(['Object', 'Symbol']);

// The runtime runs the body inside an async function (Claude Code 2.1.332), so a top-level return and await parse.
// A probe parsed seven production workflow scripts of 20 KB to 344 KB with these options.
const PARSE_OPTIONS = Object.freeze({
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
});
const HASHBANG = '#!';
// Acorn reads `<!--` in a module as code, where Node.js 24.22.1 refuses the module and a script reads a comment.
const HTML_OPEN_COMMENT = '<!--';
const RELATIVE_PREFIXES = ['./', '../'];
const MODULE_ENDINGS = ['.js', '.mjs'];
const EXPORT_TYPES = new Set(['ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration']);
// A class field value and a static block take the class or instance as `this`.
const THIS_BINDING_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'PropertyDefinition', 'StaticBlock']);
const DECLARATION_TYPES = new Set(['FunctionDeclaration', 'ClassDeclaration']);

/**
 * Parses one source file and reads its imports, its exports, the edits that turn its import and export
 * statements into plain code, and every finding that the file alone shows.
 * @param {string} text The normalized text of the file.
 * @param {string} file
 * @param {boolean} isEntry
 * @param {boolean} hasBanner For an entry, whether the build puts the banner line after its meta statement.
 * @returns {SourceAnalysis}
 */
export function analyzeSource(text, file, isEntry, hasBanner) {
  const analysis = { findings: [], imports: [], exports: [], edits: [], metaEnd: null, topLevelNames: [], freeNames: [] };
  const liveLocals = new Set();
  const comments = [];
  const htmlCommentOffsets = [];
  const addFinding = (rule, message, offset) => analysis.findings.push(createFinding(rule, message, file, text, offset));
  const onToken = (token) => {
    if (token.type === tokTypes.relational && text.startsWith(HTML_OPEN_COMMENT, token.start)) htmlCommentOffsets.push(token.start);
  };
  let program = null;

  try {
    program = parse(text, { ...PARSE_OPTIONS, onComment: comments, onToken });
  } catch (error) {
    if (!(error instanceof SyntaxError) || typeof error.pos !== 'number') throw error;
    addFinding('syntax-error', error.message.replace(/ \(\d+:\d+\)$/, ''), error.pos);
    return analysis;
  }

  for (const offset of htmlCommentOffsets) addFinding('syntax-error', `The file holds ${HTML_OPEN_COMMENT}, which an ES module does not allow`, offset);
  if (isEntry) analysis.metaEnd = checkMeta(program, text, comments, hasBanner, addFinding);
  if (isEntry && analysis.metaEnd !== null) checkMetaImports(program, addFinding);
  if (isEntry) checkScopeGlobals(program, addFinding);
  if (isEntry) analysis.topLevelNames = listTopLevelNames(program.body);
  if (!isEntry) analysis.freeNames = findFreeNames(program).map((identifier) => ({ name: identifier.name, offset: identifier.start }));
  if (!isEntry && text.startsWith(HASHBANG)) {
    addFinding('syntax-error', 'The module starts with a #! line, which is legal only at the start of a script', 0);
  }

  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      readImport(statement, text, analysis, addFinding);
    } else if (EXPORT_TYPES.has(statement.type) && isEntry) {
      // A second statement that exports meta is a syntax error, so a statement that exports meta alone is the meta statement.
      const exportedNames = statement.source ? [] : listExportedNames(statement);
      const isMetaExport = exportedNames.length === 1 && exportedNames[0] === 'meta';
      if (!isMetaExport) addFinding('entry-export', 'The entry holds an export other than meta', statement.start);
    } else if (EXPORT_TYPES.has(statement.type)) {
      readExport(statement, text, analysis, liveLocals, addFinding);
    }
  }

  checkNodes(program, isEntry, addFinding);
  for (const identifier of findExportAssignments(program, liveLocals)) {
    addFinding('export-not-constant', `The module assigns to its export ${identifier.name}`, identifier.start);
  }

  analysis.findings.sort((first, second) => first.line - second.line || first.column - second.column);
  return analysis;
}

/**
 * Checks that the entry opens with `export const meta = { ... }`. The build puts the banner and the module
 * scopes after the meta statement's last line, so when it puts a line there, no comment or literal may
 * span that line's break, and when the entry imports a module, no code may share that line.
 * @param {SyntaxNode} program
 * @param {string} text
 * @param {import('acorn').Comment[]} comments
 * @param {boolean} hasBanner
 * @param {(rule: string, message: string, offset: number) => void} addFinding
 * @returns {number | null} The offset just after the meta statement, or null when it is missing.
 */
function checkMeta(program, text, comments, hasBanner, addFinding) {
  const first = program.body[0];
  const declaration = first?.type === 'ExportNamedDeclaration' ? first.declaration : null;
  const declarator = declaration?.type === 'VariableDeclaration' && declaration.kind === 'const' && declaration.declarations.length === 1 ? declaration.declarations[0] : null;
  const isMeta = declarator?.id.type === 'Identifier' && declarator.id.name === 'meta' && declarator.init?.type === 'ObjectExpression';
  const hasImport = program.body.some((statement) => statement.type === 'ImportDeclaration');
  const metaLineBreak = isMeta ? text.indexOf('\n', first.end) : -1;
  const isOnMetaLine = (offset) => offset >= first.end && (metaLineBreak === -1 || offset < metaLineBreak);
  const isSpanningMetaLineBreak = (range) => range.start <= metaLineBreak && metaLineBreak < range.end;

  if (!isMeta) {
    addFinding('meta-not-first', 'The entry does not start with export const meta = { ... }', first?.start ?? 0);
    return null;
  }
  if (!hasImport && !hasBanner) return first.end;

  const metaLineCode = program.body
    .slice(1)
    .filter((statement) => isOnMetaLine(statement.start) && statement.type !== 'ImportDeclaration' && statement.type !== 'EmptyStatement');
  // An entry that imports may hold no code on the meta line at all, which covers a literal there.
  const spanningLiterals = hasImport ? [] : metaLineCode.flatMap(listLiterals).filter(isSpanningMetaLineBreak);
  const spanningComments = comments.filter(isSpanningMetaLineBreak);

  if (hasImport) {
    for (const statement of metaLineCode) addFinding('meta-not-alone', 'Code follows the meta statement on its last line', statement.start);
  }
  for (const literal of spanningLiterals) {
    addFinding('meta-not-alone', 'A literal that starts on the meta statement\'s last line ends on a later line', literal.start);
  }
  for (const comment of spanningComments) {
    addFinding('meta-not-alone', 'A comment that starts on the meta statement\'s last line ends on a later line', comment.start);
  }

  return first.end;
}

/**
 * Lists the string literals and template literal texts in a node, which are the tokens that can hold a line break.
 * @param {SyntaxNode} node
 * @returns {SyntaxNode[]}
 */
function listLiterals(node) {
  const isLiteral = (node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateElement';
  return [...(isLiteral ? [node] : []), ...listChildNodes(node).flatMap(listLiterals)];
}

/**
 * The built script declares the entry's imported names below the meta statement, where an ES module has
 * bound them before its first statement runs, so the meta value may not read an imported name.
 * @param {SyntaxNode} program An entry whose first statement is its meta statement.
 * @param {(rule: string, message: string, offset: number) => void} addFinding
 */
function checkMetaImports(program, addFinding) {
  const importedNames = new Set(listTopLevelNames(program.body.filter((statement) => statement.type === 'ImportDeclaration')));
  const metaProgram = { ...program, body: [program.body[0]] };
  if (importedNames.size === 0) return;

  for (const identifier of findFreeNames(metaProgram)) {
    if (importedNames.has(identifier.name)) addFinding('meta-reads-import', `The meta statement reads ${identifier.name}, which the entry imports`, identifier.start);
  }
}

/**
 * Module scopes run in the entry's top-level scope and read the globals SCOPE_GLOBALS names, so an entry
 * that imports a module may not declare one of them at its top level.
 * @param {SyntaxNode} program
 * @param {(rule: string, message: string, offset: number) => void} addFinding
 */
function checkScopeGlobals(program, addFinding) {
  const imports = program.body.filter((statement) => statement.type === 'ImportDeclaration');
  if (imports.length === 0) return;

  for (const statement of program.body) {
    const declaredNames = listTopLevelNames([statement]);
    for (const name of SCOPE_GLOBALS.filter((global) => declaredNames.includes(global))) {
      addFinding('reserved-name', `The entry declares ${name} at its top level, where the module scopes read it`, statement.start);
    }
  }
}

/**
 * @param {SyntaxNode} statement An ImportDeclaration.
 * @param {string} text
 * @param {SourceAnalysis} analysis
 * @param {(rule: string, message: string, offset: number) => void} addFinding
 */
function readImport(statement, text, analysis, addFinding) {
  const specifier = statement.source.value;
  const offset = statement.source.start;
  const bindings = statement.specifiers.map((specifierNode) => ({
    imported: readImportedName(specifierNode),
    local: specifierNode.local.name,
    offset: specifierNode.start,
  }));

  analysis.edits.push(removeStatement(statement, text));

  if (!RELATIVE_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    addFinding('import-not-relative', `The specifier ${JSON.stringify(specifier)} does not start with ./ or ../`, offset);
  } else if (statement.attributes?.length > 0) {
    addFinding('import-not-module', 'The import holds import attributes', offset);
  } else if (!MODULE_ENDINGS.some((ending) => specifier.endsWith(ending))) {
    addFinding('import-not-module', `The specifier ${JSON.stringify(specifier)} does not end in .js or .mjs`, offset);
  } else {
    analysis.imports.push({ specifier, offset, bindings });
  }
}

/**
 * @param {SyntaxNode} specifierNode
 * @returns {string}
 */
function readImportedName(specifierNode) {
  if (specifierNode.type === 'ImportDefaultSpecifier') return 'default';
  if (specifierNode.type === 'ImportNamespaceSpecifier') return '*';
  return readModuleName(specifierNode.imported);
}

/**
 * @param {SyntaxNode} statement An ExportNamedDeclaration or ExportDefaultDeclaration.
 * @returns {string[]} The names it exports.
 */
function listExportedNames(statement) {
  if (statement.type === 'ExportDefaultDeclaration') return ['default'];
  if (statement.declaration) return listDeclaredNames(statement.declaration);
  return statement.specifiers.map((specifierNode) => readModuleName(specifierNode.exported));
}

/**
 * Reads an import or export name, which ES2022 allows to be a string literal.
 * @param {SyntaxNode} node
 * @returns {string}
 */
function readModuleName(node) {
  return node.type === 'Identifier' ? node.name : String(node.value);
}

/**
 * @param {SyntaxNode} statement An export statement of a module.
 * @param {string} text
 * @param {SourceAnalysis} analysis
 * @param {Set<string>} liveLocals Collects the local names whose binding an export shares.
 * @param {(rule: string, message: string, offset: number) => void} addFinding
 */
function readExport(statement, text, analysis, liveLocals, addFinding) {
  const declaration = statement.declaration ?? null;
  const addExport = (exported, local, isLive) => {
    analysis.exports.push({ exported, local });
    if (isLive) liveLocals.add(local);
  };

  if (statement.type === 'ExportAllDeclaration' || statement.source) {
    addFinding('export-from', 'The module exports names from another file', statement.start);
    return;
  }

  if (statement.type === 'ExportNamedDeclaration' && declaration === null) {
    for (const specifierNode of statement.specifiers) addExport(readModuleName(specifierNode.exported), specifierNode.local.name, true);
    analysis.edits.push(removeStatement(statement, text));
    return;
  }

  if (statement.type === 'ExportNamedDeclaration') {
    if (declaration.type === 'VariableDeclaration' && declaration.kind !== 'const') {
      addFinding('export-not-constant', `The module exports a ${declaration.kind} binding`, statement.start);
    }
    for (const name of listDeclaredNames(declaration)) addExport(name, name, true);
    analysis.edits.push(removeText(statement.start, declaration.start, text));
    return;
  }

  if (DECLARATION_TYPES.has(declaration.type) && declaration.id) {
    addExport('default', declaration.id.name, true);
    analysis.edits.push(removeText(statement.start, declaration.start, text));
    return;
  }

  // A property definition names an anonymous function or class "default", as `export default` does.
  // The value keeps the text after `default`, since acorn's range of a parenthesized expression leaves out its parentheses.
  const valueStart = findDefaultKeywordEnd(statement, text);
  const hasSemicolon = text[statement.end - 1] === ';';
  const closerOffset = hasSemicolon ? statement.end - 1 : statement.end;
  addExport('default', DEFAULT_EXPORT_LOCAL, false);
  analysis.edits.push(removeText(statement.start, valueStart, text, `const ${DEFAULT_EXPORT_LOCAL} = { default:`));
  analysis.edits.push({ start: closerOffset, end: closerOffset, text: hasSemicolon ? ' }.default' : ' }.default;' });
}

/**
 * @param {SyntaxNode} statement An ExportDefaultDeclaration.
 * @param {string} text
 * @returns {number} The offset just after the statement's `default` keyword.
 */
function findDefaultKeywordEnd(statement, text) {
  const tokens = tokenizer(text.slice(statement.start, statement.end), PARSE_OPTIONS)[Symbol.iterator]();
  tokens.next();
  return statement.start + tokens.next().value.end;
}

/**
 * Removes an import or an export list and leaves a `;` where it stood, since the removed statement
 * separated its neighbours, which automatic semicolon insertion would otherwise join. Acorn's range can end
 * at a `;` on a later line, so the statement's own `;` stays in place.
 * @param {SyntaxNode} statement
 * @param {string} text
 * @returns {Edit}
 */
function removeStatement(statement, text) {
  const hasSemicolon = text[statement.end - 1] === ';';
  return hasSemicolon ? removeText(statement.start, statement.end - 1, text) : removeText(statement.start, statement.end, text, ';');
}

/**
 * Replaces a range with new text followed by the line breaks of the range.
 * @param {number} start
 * @param {number} end
 * @param {string} text The source text.
 * @param {string} [replacement]
 * @returns {Edit}
 */
function removeText(start, end, text, replacement = '') {
  const lineBreaks = text.slice(start, end).replace(/[^\n]/g, '');
  return { start, end, text: replacement + lineBreaks };
}

/**
 * Reports `import()`, `import.meta`, variable names with the reserved prefix and, in a module, `await` or
 * `return` outside every function, `this` outside every function that binds its own `this`, and a direct
 * `eval` call. A module's top-level `this` is undefined, and a scope's arrow function takes the `this` of the
 * runtime's arrow function instead (Claude Code 2.1.332). A computed field key takes the `this` around its class.
 * A direct `eval` in a module scope reads the entry's top-level names, which an ES module cannot reach.
 * @param {SyntaxNode} program
 * @param {boolean} isEntry
 * @param {(rule: string, message: string, offset: number) => void} addFinding
 */
function checkNodes(program, isEntry, addFinding) {
  const nameNodes = new WeakSet();
  const visitedNodes = new WeakSet();
  const visit = (node, isInsideFunction, hasOwnThis) => {
    // Acorn shares one node between the two names of `import { a }` and of `export { a }`.
    if (visitedNodes.has(node)) return;
    visitedNodes.add(node);
    const isTopLevelOfModule = !isEntry && !isInsideFunction;
    const isReservedName = node.type === 'Identifier' && !nameNodes.has(node) && node.name.startsWith(RESERVED_PREFIX);
    const bindsThis = THIS_BINDING_TYPES.has(node.type);
    const outerThisKey = node.type === 'PropertyDefinition' && node.computed ? node.key : null;
    // Acorn gives `await using` no AwaitExpression node.
    const isAwait = node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await) || (node.type === 'VariableDeclaration' && node.kind === 'await using');

    if (node.type === 'ImportExpression') {
      addFinding('import-dynamic', 'The file holds import()', node.start);
    } else if (node.type === 'MetaProperty' && node.meta.name === 'import') {
      addFinding('import-meta', 'The file holds import.meta', node.start);
    } else if (isReservedName) {
      addFinding('reserved-name', `The name ${node.name} starts with ${RESERVED_PREFIX}`, node.start);
    } else if (isTopLevelOfModule && isAwait) {
      addFinding('module-top-level-await', 'The module uses await outside every function', node.start);
    } else if (isTopLevelOfModule && node.type === 'ReturnStatement') {
      addFinding('module-top-level-await', 'The module uses return outside every function', node.start);
    } else if (!isEntry && !hasOwnThis && node.type === 'ThisExpression') {
      addFinding('module-top-level-this', 'The module uses this outside every function', node.start);
    } else if (!isEntry && isDirectEval(node)) {
      addFinding('module-direct-eval', 'The module calls eval directly', node.start);
    }

    for (const child of listNameChildren(node)) nameNodes.add(child);
    for (const child of listChildNodes(node)) {
      visit(child, isInsideFunction || isFunctionNode(node), hasOwnThis || (bindsThis && child !== outerThisKey));
    }
  };

  visit(program, false, false);
}

/**
 * Strict code cannot bind the name `eval`, so a plain call of it is a direct eval. An optional call
 * `eval?.()` is an indirect eval, which reads only globals.
 * @param {SyntaxNode} node
 * @returns {boolean}
 */
function isDirectEval(node) {
  return node.type === 'CallExpression' && !node.optional && node.callee.type === 'Identifier' && node.callee.name === 'eval';
}
