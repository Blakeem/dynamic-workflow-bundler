import { createHash } from 'node:crypto';
import { RESERVED_PREFIX } from './analyze-source.js';

/** @typedef {import('./analyze-source.js').Edit} Edit */
/** @typedef {import('./analyze-source.js').ExportRecord} ExportRecord */
/** @typedef {import('./load-sources.js').Dependency} Dependency */
/** @typedef {import('./load-sources.js').LoadedSource} LoadedSource */

/**
 * @typedef {LoadedSource & { path: string }} JoinedModule
 * `path` is the module's path relative to the entry's folder, with forward slashes.
 */

const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/;
const SCOPE_HASH_LENGTH = 8;
const LINE_TERMINATORS = /[\n\r\u2028\u2029]/g;

/**
 * Writes the built script: the entry's meta statement, the banner line, one scope per module and the
 * rest of the entry. Every source line keeps its order and line count.
 * Each scope wraps the form `const <name> = (() => { ...; return { ... }; })();` in a freeze. A probe
 * under Claude Code 2.1.332 ran that form with class fields, runtime globals and shared module state.
 * The scope's object takes the `Symbol.toStringTag` of an ES module namespace. The freeze makes a namespace
 * import frozen, where an ES module namespace is sealed with writable members. A write to a member throws
 * in both.
 * @param {object} input
 * @param {LoadedSource} input.entry An entry with no finding.
 * @param {JoinedModule[]} input.modules In evaluation order.
 * @param {string | null} input.bannerPath The entry's path relative to the built script's folder, or null for no banner.
 * @returns {string}
 */
export function joinModules({ entry, modules, bannerPath }) {
  const scopeNames = new Map(modules.map((module) => [module.file, nameScope(module.path)]));
  const entryText = applyEdits(entry.text, entry.analysis.edits);
  const metaLastLine = countLineBreaks(entry.text.slice(0, entry.analysis.metaEnd)) + 1;
  const splitOffset = findOffsetAfterLine(entryText, metaLastLine);
  const head = entryText.slice(0, splitOffset);
  const entryBindings = formatBindings(entry.dependencies, scopeNames);
  const parts = [head];

  if (bannerPath !== null) {
    const separator = head.endsWith('\n') ? '' : '\n';
    parts.push(`${separator}// Built by dynamic-workflow-bundler from ${formatCommentText(bannerPath)}. Edit the source, not this file.\n`);
  }
  for (const module of modules) parts.push(formatScope(module, scopeNames));
  if (entryBindings !== '') parts.push(`${entryBindings}\n`);
  parts.push(entryText.slice(splitOffset));

  return parts.join('');
}

/**
 * Names a scope from its module's path alone, so adding a module renames no other scope.
 * The hash keeps two paths that differ only in punctuation, such as `a-b.js` and `a_b.js`, apart.
 * @param {string} path
 * @returns {string}
 */
export function nameScope(path) {
  const stem = path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const hash = createHash('sha256').update(path).digest('hex').slice(0, SCOPE_HASH_LENGTH);
  return `${RESERVED_PREFIX}${stem}_${hash}`;
}

/**
 * @param {JoinedModule} module
 * @param {Map<string, string>} scopeNames
 * @returns {string}
 */
function formatScope(module, scopeNames) {
  const bindings = formatBindings(module.dependencies, scopeNames);
  const body = applyEdits(module.text, module.analysis.edits);
  const closedBody = body === '' || body.endsWith('\n') ? body : `${body}\n`;
  const exportNames = formatExports(module.analysis.exports);
  // The freeze and the tag sit outside the scope, so a module that declares its own Object or Symbol cannot reach them.
  const opening = `// ${formatCommentText(module.path)}\nconst ${scopeNames.get(module.file)} = Object.freeze(Object.defineProperty((() => {${bindings === '' ? '' : ` ${bindings}`}\n`;
  const closing = `return { __proto__: null${exportNames === '' ? '' : `, ${exportNames}`} }; })(), Symbol.toStringTag, { value: 'Module' }));\n`;

  return `${opening}${closedBody}${closing}`;
}

/**
 * Declares a file's imported names at the top of its code, so a name is usable above its import statement.
 * @param {Dependency[]} dependencies
 * @param {Map<string, string>} scopeNames
 * @returns {string}
 */
function formatBindings(dependencies, scopeNames) {
  const declarations = [];

  for (const { record, target } of dependencies) {
    const scopeName = scopeNames.get(target);
    const named = record.bindings.filter((binding) => binding.imported !== '*');
    const namespaces = record.bindings.filter((binding) => binding.imported === '*');
    if (named.length > 0) {
      declarations.push(`const { ${named.map((binding) => formatProperty(binding.imported, binding.local)).join(', ')} } = ${scopeName};`);
    }
    for (const binding of namespaces) declarations.push(`const ${binding.local} = ${scopeName};`);
  }

  return declarations.join(' ');
}

/**
 * Lists the exports in code unit order, which is the key order of an ES module namespace object.
 * @param {ExportRecord[]} exports
 * @returns {string}
 */
function formatExports(exports) {
  return [...exports]
    .sort((first, second) => (first.exported < second.exported ? -1 : first.exported > second.exported ? 1 : 0))
    .map((exportRecord) => formatProperty(exportRecord.exported, exportRecord.local))
    .join(', ');
}

/**
 * A plain `__proto__` key would set the prototype of an object literal, so it takes the computed form.
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function formatProperty(key, value) {
  if (key === '__proto__') return `["__proto__"]: ${value}`;
  if (!IDENTIFIER_NAME.test(key)) return `${JSON.stringify(key)}: ${value}`;
  return key === value ? key : `${key}: ${value}`;
}

/**
 * Escapes line terminators, so a path cannot end its comment line.
 * @param {string} text
 * @returns {string}
 */
function formatCommentText(text) {
  return text.replace(LINE_TERMINATORS, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * @param {string} text
 * @param {Edit[]} edits In source order, with no overlap.
 * @returns {string}
 */
function applyEdits(text, edits) {
  const pieces = [];
  let position = 0;

  for (const edit of edits) {
    pieces.push(text.slice(position, edit.start), edit.text);
    position = edit.end;
  }
  pieces.push(text.slice(position));

  return pieces.join('');
}

/**
 * @param {string} text
 * @returns {number}
 */
function countLineBreaks(text) {
  return text.split('\n').length - 1;
}

/**
 * @param {string} text
 * @param {number} line 1-based.
 * @returns {number} The offset just after the line's line break, or the text's length when the line has none.
 */
function findOffsetAfterLine(text, line) {
  let offset = 0;

  for (let current = 0; current < line; current += 1) {
    const breakIndex = text.indexOf('\n', offset);
    if (breakIndex === -1) return text.length;
    offset = breakIndex + 1;
  }

  return offset;
}
