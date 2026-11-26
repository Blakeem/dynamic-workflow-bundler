import { createHash } from 'node:crypto';
import { RESERVED_PREFIX } from './analyze-source.js';
import { findLineOrigin } from './expand-parts.js';
import { countLineBreaks } from './source-position.js';

/** @typedef {import('./analyze-source.js').Edit} Edit */
/** @typedef {import('./analyze-source.js').ExportRecord} ExportRecord */
/** @typedef {import('./load-sources.js').Dependency} Dependency */
/** @typedef {import('./load-sources.js').LoadedSource} LoadedSource */

/**
 * @typedef {LoadedSource & { path: string }} JoinedSource
 * `path` is the source's path relative to the entry's folder, with forward slashes.
 */

const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/;
const SOURCE_NAME_HASH_LENGTH = 8;
const LINE_TERMINATORS = /[\n\r\u2028\u2029]/g;
const TEMPLATE_SPECIAL_TEXT = /\\|`|\$\{|\r/g;
// A template literal reads a raw CR as LF, so a lone CR of a text file takes its escape.
const TEMPLATE_ESCAPES = Object.freeze({ '\\': '\\\\', '`': '\\`', '${': '\\${', '\r': '\\r' });

/**
 * @typedef {object} LineOrigin
 * @property {string | null} file The real path of the source that the line comes from. For a line the build
 *   adds, the source whose constant, scope or imported names the line holds, or null for the banner.
 * @property {number | null} line The source's 1-based line, or null for a line the build adds.
 */

/**
 * @typedef {object} ScriptPiece
 * @property {string} text
 * @property {(line: number) => LineOrigin} findOrigin Maps a 1-based line of `text` to its origin.
 */

/**
 * @typedef {object} JoinedScript
 * @property {string} script
 * @property {LineOrigin[]} lineOrigins One per line of the script, as `script.split('\n')` gives the lines,
 *   so index 0 holds line 1.
 */

/**
 * Writes the built script: the entry's meta statement, the banner line, one constant per text file and
 * JSON file, one scope per module and the rest of the entry. Every source line keeps its order and line count.
 * Each scope wraps the form `const <name> = (() => { ...; return { ... }; })();` in a freeze. A probe
 * under Claude Code 2.1.332 ran that form with class fields, runtime globals and shared module state.
 * The scope's object takes the `Symbol.toStringTag` of an ES module namespace. The freeze makes a namespace
 * import frozen, where an ES module namespace is sealed with writable members. A write to a member throws
 * in both.
 * @param {object} input
 * @param {LoadedSource} input.entry An entry with no finding.
 * @param {JoinedSource[]} input.sources The sources other than the entry, in evaluation order.
 * @param {string | null} input.bannerPath The entry's path relative to the built script's folder, or null for no banner.
 * @returns {JoinedScript}
 */
export function joinModules({ entry, sources, bannerPath }) {
  const sourceNames = new Map(sources.map((source) => [source.file, nameSource(source.path)]));
  const entryText = applyEdits(entry.text, entry.analysis.edits);
  const metaLastLine = countLineBreaks(entry.text.slice(0, entry.analysis.metaEnd)) + 1;
  const splitOffset = findOffsetAfterLine(entryText, metaLastLine);
  const head = entryText.slice(0, splitOffset);
  const entryBindings = formatBindings(entry.dependencies, sourceNames);
  const findEntryOrigin = (line) => {
    const origin = findLineOrigin(entry.includes, line);
    return { file: origin.file ?? entry.file, line: origin.line };
  };
  const pieces = [{ text: head, findOrigin: findEntryOrigin }];

  if (bannerPath !== null) {
    const separator = head.endsWith('\n') ? '' : '\n';
    pieces.push(addedPiece(`${separator}// Built by dynamic-workflow-bundler from ${formatCommentText(bannerPath)}. Edit the source, not this file.\n`, null));
  }
  for (const source of sources.filter((each) => each.kind === 'text')) pieces.push(...formatTextFile(source, sourceNames));
  for (const source of sources.filter((each) => each.kind === 'json')) pieces.push(...formatJsonFile(source, sourceNames));
  for (const source of sources.filter((each) => each.kind === 'module')) pieces.push(...formatScope(source, sourceNames));
  if (entryBindings !== '') pieces.push(addedPiece(`${entryBindings}\n`, entry.file));
  pieces.push({ text: entryText.slice(splitOffset), findOrigin: (line) => findEntryOrigin(metaLastLine + line) });

  return { script: pieces.map((piece) => piece.text).join(''), lineOrigins: mapLineOrigins(pieces) };
}

/**
 * Gives each line of the joined pieces the origin of the piece where the line starts. The line after the
 * script's last line break takes the origin of the last piece's next line.
 * @param {ScriptPiece[]} pieces
 * @returns {LineOrigin[]}
 */
function mapLineOrigins(pieces) {
  const origins = [];
  let isLineStart = true;

  for (const { text, findOrigin } of pieces) {
    const lines = text.split('\n');
    lines.forEach((lineText, index) => {
      const continuesLine = index === 0 && !isLineStart;
      const isAfterLastBreak = index === lines.length - 1 && lineText === '';
      if (!continuesLine && !isAfterLastBreak) origins.push(findOrigin(index + 1));
    });
    if (text !== '') isLineStart = text.endsWith('\n');
  }
  const lastPiece = pieces[pieces.length - 1];
  if (isLineStart) origins.push(lastPiece.findOrigin(countLineBreaks(lastPiece.text) + 1));

  return origins;
}

/**
 * @param {string} text Lines the build adds.
 * @param {string | null} file
 * @returns {ScriptPiece}
 */
function addedPiece(text, file) {
  return { text, findOrigin: () => ({ file, line: null }) };
}

/**
 * @param {string} text The source's lines, in their order and count.
 * @param {JoinedSource} source
 * @returns {ScriptPiece}
 */
function sourcePiece(text, source) {
  return { text, findOrigin: (line) => ({ file: source.file, line }) };
}

/**
 * Names the constant that holds a source in the built script, from the source's path alone, so adding a
 * source renames no other constant. The constant holds a module's scope, a text file's string or a JSON
 * file's value. The hash keeps two paths that differ only in punctuation, such as `a-b.js` and `a_b.js`, apart.
 * @param {string} path
 * @returns {string}
 */
export function nameSource(path) {
  const stem = path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const hash = createHash('sha256').update(path).digest('hex').slice(0, SOURCE_NAME_HASH_LENGTH);
  return `${RESERVED_PREFIX}${stem}_${hash}`;
}

/**
 * Holds a text file in a template literal whose lines are the file's lines. The line continuation after
 * the opening backtick puts the file's first line on a line of its own and adds nothing to the string.
 * A probe under Claude Code 2.1.332 gave the exact text for an escaped backtick, `${` and backslash.
 * @param {JoinedSource} source
 * @param {Map<string, string>} sourceNames
 * @returns {ScriptPiece[]}
 */
function formatTextFile(source, sourceNames) {
  return formatTemplateConstant(source, `const ${sourceNames.get(source.file)} = `, ';');
}

/**
 * Parses a JSON file's text when the script runs, since an object literal of that text would read a
 * `__proto__` key as the prototype, where JSON.parse makes it a property.
 * @param {JoinedSource} source
 * @param {Map<string, string>} sourceNames
 * @returns {ScriptPiece[]}
 */
function formatJsonFile(source, sourceNames) {
  return formatTemplateConstant(source, `const ${sourceNames.get(source.file)} = JSON.parse(`, ');');
}

/**
 * Holds a source's text in a template literal closed on the text's last line.
 * @param {JoinedSource} source
 * @param {string} before The code between the comment line and the template literal.
 * @param {string} after The code after the template literal on its closing line.
 * @returns {ScriptPiece[]}
 */
function formatTemplateConstant(source, before, after) {
  const escapedText = source.text.replace(TEMPLATE_SPECIAL_TEXT, (special) => TEMPLATE_ESCAPES[special]);

  return [
    addedPiece(`// ${formatCommentText(source.path)}\n${before}\`\\\n`, source.file),
    sourcePiece(escapedText, source),
    addedPiece(`\`${after}\n`, source.file),
  ];
}

/**
 * @param {JoinedSource} module
 * @param {Map<string, string>} sourceNames
 * @returns {ScriptPiece[]}
 */
function formatScope(module, sourceNames) {
  const bindings = formatBindings(module.dependencies, sourceNames);
  const body = applyEdits(module.text, module.analysis.edits);
  const closedBody = body === '' || body.endsWith('\n') ? body : `${body}\n`;
  const exportNames = formatExports(module.analysis.exports);
  // The freeze and the tag sit outside the scope, so a module that declares its own Object or Symbol cannot reach them.
  const opening = `// ${formatCommentText(module.path)}\nconst ${sourceNames.get(module.file)} = Object.freeze(Object.defineProperty((() => {${bindings === '' ? '' : ` ${bindings}`}\n`;
  const closing = `return { __proto__: null${exportNames === '' ? '' : `, ${exportNames}`} }; })(), Symbol.toStringTag, { value: 'Module' }));\n`;

  return [addedPiece(opening, module.file), sourcePiece(closedBody, module), addedPiece(closing, module.file)];
}

/**
 * Declares a file's imported names at the top of its code, so a name is usable above its import statement.
 * A text file's or a JSON file's default import names the source's constant itself, so every importer of a
 * JSON file reads one object, as with an ES JSON module.
 * @param {Dependency[]} dependencies
 * @param {Map<string, string>} sourceNames
 * @returns {string}
 */
function formatBindings(dependencies, sourceNames) {
  const declarations = [];

  for (const { record, target } of dependencies) {
    const sourceName = sourceNames.get(target);
    const isModule = record.kind === 'module';
    const named = record.bindings.filter((binding) => isModule && binding.imported !== '*');
    const entireValues = record.bindings.filter((binding) => !isModule || binding.imported === '*');
    if (named.length > 0) {
      declarations.push(`const { ${named.map((binding) => formatProperty(binding.imported, binding.local)).join(', ')} } = ${sourceName};`);
    }
    for (const binding of entireValues) declarations.push(`const ${binding.local} = ${sourceName};`);
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
