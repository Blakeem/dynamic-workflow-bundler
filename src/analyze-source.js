import { posix } from 'node:path';
import { tokenizer, tokTypes } from 'acorn';
import { RUNTIME_RESERVED_PREFIX } from './check-contract.js';
import { createFinding } from './finding.js';
import { isIncludeComment } from './find-include-directives.js';
import { findExportAssignments } from './find-export-assignments.js';
import { findFreeNames } from './find-free-names.js';
import { readMetaObject } from './meta-statement.js';
import { formatSyntaxErrorReason, isStackSpaceError, PARSE_OPTIONS, PARSER_DEPTH_MESSAGE, parseSource } from './parse-source.js';
import { EXPORT_TYPES, findDeepestNode, isFunctionNode, isStackOverflowError, listChildNodes, listDeclaredNames, listNameChildren, listTopLevelNames } from './syntax-tree.js';

/** @typedef {import('./expand-parts.js').IncludedPart} IncludedPart */
/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./syntax-tree.js').SyntaxNode} SyntaxNode */
/** @typedef {'module' | 'text' | 'json'} SourceKind */

/**
 * @typedef {object} ImportBinding
 * @property {string | null} imported An export name, or null for a namespace import.
 * @property {string} local
 * @property {number} offset The offset of the imported name.
 */

/**
 * @typedef {object} ImportRecord
 * @property {string} specifier
 * @property {number} offset The offset of the specifier.
 * @property {ImportBinding[]} bindings Empty for an import that only evaluates the module. For a text file
 *   or a JSON file, at most one binding, of the name `default`.
 * @property {SourceKind} kind What the import names.
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
 * @property {ImportRecord[]} imports The imports that name a source file with no finding, in source order.
 * @property {ExportRecord[]} exports
 * @property {Edit[]} edits In source order, with no overlap.
 * @property {number | null} metaEnd For an entry, the offset just after its meta statement.
 * @property {string[]} topLevelNames For an entry, the names its top level declares after its meta statement.
 *   Empty for a module.
 * @property {FreeName[]} freeNames For a module, the names it reads that none of its scopes declares, in
 *   source order. Empty for an entry.
 * @property {BuildGlobalDeclaration[]} buildGlobalDeclarations For an entry, each top-level statement's
 *   declaration of a name that BUILD_GLOBAL_READERS lists, in source order. Empty for a module.
 */

/**
 * @typedef {object} BuildGlobalDeclaration
 * @property {string} name
 * @property {number} offset The offset of the statement that declares the name.
 */

export const RESERVED_PREFIX = '__dwfb_';
export const DEFAULT_EXPORT_LOCAL = `${RESERVED_PREFIX}default`;
/**
 * @type {Readonly<Record<string, SourceKind>>} Each global that the code the build adds reads, with the kind
 * of source whose code reads it, from formatScope and formatJsonFile in join-modules.js.
 */
export const BUILD_GLOBAL_READERS = Object.freeze({ Object: 'module', Symbol: 'module', JSON: 'json' });
/** @type {Readonly<Record<SourceKind, string>>} The word for each kind of source in a message. */
export const SOURCE_KIND_NAMES = Object.freeze({ module: 'module', text: 'text file', json: 'JSON file' });

const HASHBANG = '#!';
// Acorn reads `<!--` in a module as code, where Node.js 24.22.1 refuses the module and a script reads a comment.
const HTML_OPEN_COMMENT = '<!--';
const RELATIVE_PREFIXES = ['./', '../'];
// Any folder URL works, since a relative specifier's own segments decide its path's ending and whether it ends in `/`.
const SPECIFIER_BASE_URL = 'file:///folder/';
const MODULE_ENDINGS = ['.js', '.mjs'];
const JSON_ENDING = '.json';
// Node.js 24.22.1 imports each ending as code or JSON and refuses it in another letter case, so none gives a string.
const RUNTIME_CODE_ENDINGS = ['.js', '.mjs', '.cjs', '.json', '.ts', '.mts', '.cts', '.wasm', '.node'];
const IMPORT_TYPES = new Set(['text', 'json']);
// A class field value and a static block take the class or instance as `this`.
const THIS_BINDING_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'PropertyDefinition', 'StaticBlock']);
const DECLARATION_TYPES = new Set(['FunctionDeclaration', 'ClassDeclaration']);
/** The message of the source-too-deep finding for a source that acorn parses and a tree walk overflows on. */
const TREE_DEPTH_MESSAGE = 'The file nests code deeper than the build can read';

/**
 * Parses one source file and reads its imports, its exports, the edits that turn its import and export
 * statements into plain code, and every finding that the file alone shows.
 * @param {string} text The normalized text of the file.
 * @param {string} file
 * @param {boolean} isEntry
 * @param {boolean} hasBanner For an entry, whether the build puts the banner line after its meta statement.
 * @param {IncludedPart[]} [includes] For an entry, the parts that `text` holds in place of their directives.
 * @returns {SourceAnalysis}
 */
export function analyzeSource(text, file, isEntry, hasBanner, includes = []) {
  const analysis = { findings: [], imports: [], exports: [], edits: [], metaEnd: null, topLevelNames: [], freeNames: [], buildGlobalDeclarations: [] };
  const liveLocals = new Set();
  const comments = [];
  const htmlCommentOffsets = [];
  const addFinding = (rule, message, offset) => analysis.findings.push(createFinding(rule, message, file, text, offset));
  const onToken = (token) => {
    if (token.type === tokTypes.relational && text.startsWith(HTML_OPEN_COMMENT, token.start)) htmlCommentOffsets.push(token.start);
  };
  let program = null;

  try {
    program = parseSource(text, { ...PARSE_OPTIONS, onComment: comments, onToken });
  } catch (error) {
    if (!(error instanceof SyntaxError) || typeof error.pos !== 'number') throw error;
    if (isStackSpaceError(error)) addFinding('source-too-deep', PARSER_DEPTH_MESSAGE, error.pos);
    else addFinding('syntax-error', formatSyntaxErrorReason(error), error.pos);
    return analysis;
  }

  try {
    for (const offset of htmlCommentOffsets) addFinding('syntax-error', `The file holds ${HTML_OPEN_COMMENT}, which an ES module does not allow`, offset);
    if (isEntry) analysis.metaEnd = checkMeta(program, text, comments, hasBanner, addFinding);
    if (isEntry && analysis.metaEnd !== null) checkMetaImports(program, addFinding);
    if (isEntry) analysis.buildGlobalDeclarations = listBuildGlobalDeclarations(program);
    if (isEntry) checkPartBoundaries(program, includes, addFinding);
    // The runtime compiles only the text after the meta statement (Claude Code 2.1.332), so its body binds no meta.
    if (isEntry) analysis.topLevelNames = listTopLevelNames(analysis.metaEnd === null ? program.body : program.body.slice(1));
    if (!isEntry) analysis.freeNames = findFreeNames(program).map((identifier) => ({ name: identifier.name, offset: identifier.start }));
    // A scope's arrow function takes the arguments of the code around the runtime's arrow function (Claude Code 2.1.332).
    for (const { offset } of analysis.freeNames.filter((freeName) => freeName.name === 'arguments')) {
      addFinding('module-top-level-arguments', 'The module uses arguments outside every function that binds its own arguments', offset);
    }
    if (!isEntry && text.startsWith(HASHBANG)) {
      addFinding('syntax-error', 'The module starts with a #! line, which is legal only at the start of a script', 0);
    }
    if (!isEntry) {
      for (const comment of comments.filter(isIncludeComment)) {
        addFinding('include-misplaced', 'The module holds a // @include comment, which only the entry may hold', comment.start);
      }
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
  } catch (error) {
    // Acorn parses a member or call chain in a loop, so a chain too deep for the recursive tree walks still parses.
    if (!isStackOverflowError(error)) throw error;
    addFinding('source-too-deep', TREE_DEPTH_MESSAGE, findDeepestNode(program).start);
  }

  analysis.findings.sort((first, second) => first.line - second.line || first.column - second.column);
  return analysis;
}

/**
 * Checks that the entry opens with `export const meta = { ... }`. The build puts the banner, the text file
 * and JSON file constants and the module scopes after the meta statement's last line, so when it puts a line
 * there, no comment or literal may span that line's break, and when the entry imports a source file, no code
 * may share that line.
 * @param {SyntaxNode} program
 * @param {string} text
 * @param {import('acorn').Comment[]} comments
 * @param {boolean} hasBanner
 * @param {(rule: string, message: string, offset: number) => void} addFinding
 * @returns {number | null} The offset just after the meta statement, or null when it is missing.
 */
function checkMeta(program, text, comments, hasBanner, addFinding) {
  const first = program.body[0];
  const isMeta = readMetaObject(first) !== null;
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
 * @param {SyntaxNode} program
 * @returns {BuildGlobalDeclaration[]}
 */
function listBuildGlobalDeclarations(program) {
  return program.body.flatMap((statement) => listTopLevelNames([statement])
    .filter((name) => Object.hasOwn(BUILD_GLOBAL_READERS, name))
    .map((name) => ({ name, offset: statement.start })));
}

/**
 * A part's text joins the entry's code around it. A statement that runs across the line break where a
 * part starts or ends, as `a` then `(b)` does without a semicolon, would read the two sides as one
 * statement that neither side holds on its own.
 * @param {SyntaxNode} program
 * @param {IncludedPart[]} includes
 * @param {(rule: string, message: string, offset: number) => void} addFinding
 */
function checkPartBoundaries(program, includes, addFinding) {
  const boundaries = [...new Set(includes.flatMap((include) => [include.start, include.end]))];

  for (const statement of program.body) {
    for (const boundary of boundaries.filter((offset) => statement.start < offset && offset < statement.end)) {
      addFinding('statement-crosses-part', 'A statement runs on into this line from the line above it in the built script, where a part starts or ends', boundary);
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
  const kindRead = readImportKind(statement, specifier);
  const otherSpecifier = statement.specifiers.find((specifierNode) => specifierNode.type !== 'ImportDefaultSpecifier');

  analysis.edits.push(removeStatement(statement, text));

  if (!RELATIVE_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    addFinding('import-not-relative', `The specifier ${JSON.stringify(specifier)} does not start with ./ or ../`, offset);
  } else if (isFolderSpecifier(specifier)) {
    addFinding('import-not-found', `The specifier ${JSON.stringify(specifier)} names a folder`, offset);
  } else if ('message' in kindRead) {
    addFinding(kindRead.rule, kindRead.message, kindRead.offset);
  } else if (kindRead.kind !== 'module' && otherSpecifier !== undefined) {
    const form = otherSpecifier.type === 'ImportNamespaceSpecifier' ? 'a namespace' : 'a named';
    addFinding('import-not-default', `The ${SOURCE_KIND_NAMES[kindRead.kind]} ${JSON.stringify(specifier)} is imported with ${form} import`, otherSpecifier.start);
  } else if (kindRead.kind !== 'module' && bindings.length === 0) {
    addFinding('import-not-default', `The ${SOURCE_KIND_NAMES[kindRead.kind]} ${JSON.stringify(specifier)} is imported with no binding`, statement.start);
  } else {
    analysis.imports.push({ specifier, offset, bindings, kind: kindRead.kind });
  }
}

/**
 * @param {string} specifier A relative specifier.
 * @returns {boolean} True for a specifier whose URL path ends in `/`, such as `./`, `./lib/` or `./..`, which
 *   names a folder and no file.
 */
function isFolderSpecifier(specifier) {
  return new URL(specifier, SPECIFIER_BASE_URL).pathname.endsWith('/');
}

/**
 * Reads what an import names. Its `type` attribute decides when it holds one, and else the ending of the
 * specifier's path after percent decoding: `.js` and `.mjs` name a module, `.json` a JSON file and every
 * other ending a text file, except no ending and an ending that an ES runtime reads as code or JSON, such as
 * `.cjs`, `.ts` or `.JSON`.
 * @param {SyntaxNode} statement An ImportDeclaration.
 * @param {string} specifier
 * @returns {{ kind: SourceKind } | { rule: string, message: string, offset: number }} The second form for an
 *   attribute that is not `type`, a type that is not `text` or `json`, or an ending that is refused.
 */
function readImportKind(statement, specifier) {
  // resolveImport in load-sources.js decodes percent escapes, so the ending is read from the decoded path.
  const endingPath = decodeSpecifierPath(specifier);
  const lowerCaseEndingPath = endingPath.toLowerCase();
  const quotedSpecifier = JSON.stringify(specifier);
  let type = null;

  for (const attribute of statement.attributes ?? []) {
    const key = readModuleName(attribute.key);
    if (key !== 'type') return { rule: 'import-attribute-unknown', message: `The import holds the attribute ${JSON.stringify(key)}`, offset: attribute.start };
    if (!IMPORT_TYPES.has(attribute.value.value)) {
      const message = `The import's type ${JSON.stringify(attribute.value.value)} is neither "text" nor "json"`;
      return { rule: 'import-attribute-unknown', message, offset: attribute.value.start };
    }
    type = attribute.value.value;
  }

  if (type !== null) return { kind: type };
  if (MODULE_ENDINGS.some((ending) => endingPath.endsWith(ending))) return { kind: 'module' };
  if (endingPath.endsWith(JSON_ENDING)) return { kind: 'json' };
  // Node.js 24.22.1 imports a file with no ending as code.
  if (posix.extname(endingPath) === '') {
    const message = `The specifier ${quotedSpecifier} has no ending, which an ES runtime reads as code and the build would read as a text file`;
    return { rule: 'import-ending-unknown', message, offset: statement.source.start };
  }
  if (RUNTIME_CODE_ENDINGS.some((ending) => lowerCaseEndingPath.endsWith(ending))) {
    const message = `The specifier ${quotedSpecifier} has an ending that an ES runtime reads as code or JSON, which the build would read as a text file`;
    return { rule: 'import-ending-unknown', message, offset: statement.source.start };
  }
  return { kind: 'text' };
}

/**
 * @param {string} specifier
 * @returns {string} The specifier's URL path with its percent escapes decoded, or the specifier itself when
 *   an escape is malformed, as in `./100%.md`, which the loader reports as naming no file path, or when it is
 *   no URL, as in `http://[`, which import-not-relative reports.
 */
function decodeSpecifierPath(specifier) {
  try {
    return decodeURIComponent(new URL(specifier, SPECIFIER_BASE_URL).pathname);
  } catch (error) {
    if (!(error instanceof URIError) && error.code !== 'ERR_INVALID_URL') throw error;
    return specifier;
  }
}

/**
 * @param {SyntaxNode} specifierNode
 * @returns {string | null} Null for a namespace import, since `import { "*" as a }` names an export `*`.
 */
function readImportedName(specifierNode) {
  if (specifierNode.type === 'ImportDefaultSpecifier') return 'default';
  if (specifierNode.type === 'ImportNamespaceSpecifier') return null;
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
 * Reports `import()`, `import.meta`, variable names with the build's or the runtime's reserved prefix and,
 * in a module, `await` or `return` outside every function, `this` outside every function that binds its own
 * `this`, and a direct `eval` call. A module's top-level `this` is undefined, and a scope's arrow function
 * takes the `this` of the runtime's arrow function instead (Claude Code 2.1.332). A computed field key takes
 * the `this` around its class.
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
    const isVariableName = node.type === 'Identifier' && !nameNodes.has(node);
    const isReservedName = isVariableName && node.name.startsWith(RESERVED_PREFIX);
    // A source's names reach the built script unchanged, and the runtime refuses a name with its prefix (Claude Code 2.1.332).
    const isRuntimeReservedName = isVariableName && node.name.startsWith(RUNTIME_RESERVED_PREFIX);
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
    } else if (isRuntimeReservedName) {
      addFinding('runtime-reserved-name', `The name ${node.name} starts with ${RUNTIME_RESERVED_PREFIX}`, node.start);
    } else if (isTopLevelOfModule && isAwait) {
      addFinding('module-top-level-await', 'The module uses await outside every function', node.start);
    } else if (isTopLevelOfModule && node.type === 'ReturnStatement') {
      addFinding('module-top-level-return', 'The module uses return outside every function', node.start);
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
