import { realpath as realpathByCallback } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { analyzeSource, SOURCE_KIND_NAMES } from './analyze-source.js';
import { checkPart } from './check-part.js';
import { expandParts, findExpandedOffset } from './expand-parts.js';
import { findDirectives } from './find-directives.js';
import { checkJsonFile } from './find-json-error.js';
import { createFinding } from './finding.js';
import { normalizeSourceText, normalizeTextFile } from './normalize-source-text.js';

/** @typedef {import('./analyze-source.js').ImportRecord} ImportRecord */
/** @typedef {import('./analyze-source.js').SourceAnalysis} SourceAnalysis */
/** @typedef {import('./analyze-source.js').SourceKind} SourceKind */
/** @typedef {import('./expand-parts.js').IncludedPart} IncludedPart */
/** @typedef {import('./expand-parts.js').PartReplacement} PartReplacement */
/** @typedef {import('./finding.js').Finding} Finding */

/**
 * @typedef {object} Dependency
 * @property {ImportRecord} record
 * @property {string} target The real path of the imported file.
 */

/**
 * @typedef {object} LoadedSource
 * @property {string} file The real path, which identifies the source.
 * @property {string} loaderFile The path the Node.js module loader identifies the source by.
 * @property {SourceKind} kind The entry is a module.
 * @property {string} text The normalized text. The entry's holds each part that passed its checks in place
 *   of the part's directive.
 * @property {SourceAnalysis | null} analysis Null for a text file and a JSON file.
 * @property {Dependency[]} dependencies The imports that name an existing file, in source order.
 * @property {IncludedPart[]} includes For the entry, the parts its text holds, in order. Empty for every
 *   other source.
 */

/**
 * @typedef {object} LoadedGraph
 * @property {Map<string, LoadedSource>} sources Keyed by real path, in the order they were read, entry first.
 * @property {string[]} parts The real path of each part that a directive names, in directive order.
 * @property {Finding[]} findings The findings of every source and part, one per import that resolveImport
 *   refuses, one per directive that includeParts refuses, one per module import of a part, and one for an
 *   entry that is not valid UTF-8.
 */

/**
 * @typedef {object} DirectiveProblem
 * @property {string} rule
 * @property {string} message
 * @property {number} offset The offset of the directive in the entry's own text.
 */

/** The error codes of a file system call on a path that names no file. */
export const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR']);
const UNLISTABLE_FOLDER_CODES = new Set(['EACCES', 'EPERM']);

// The Node.js module loader uses the JavaScript fs.realpath, which keeps letter case and Windows short names where fs.promises.realpath does not.
const realpathKeepingCase = promisify(realpathByCallback);
// readFile puts U+FFFD in place of a byte sequence that is not UTF-8, where a fatal decoder refuses it.
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Reads the entry, the part each of its directives names, and every module, text file and JSON file that
 * its imports reach. Real paths identify a source. The Node.js module loader identifies a module by a path that keeps the
 * spelling of each specifier, such as its letter case or a Windows short name, and by its query and
 * fragment. So resolveImport refuses a specifier whose case differs from its file's, one that holds a query
 * or a fragment, and one that names a source already read under another loader path. resolveImport and
 * readPart refuse a source on another drive than the entry, which the built script cannot name by a relative path.
 * @param {string} entryPath The entry's absolute path, as the caller spells it.
 * @param {boolean} hasBanner Whether the build puts the banner line after the entry's meta statement.
 * @returns {Promise<LoadedGraph>}
 */
export async function loadSources(entryPath, hasBanner) {
  const sources = new Map();
  const findings = [];
  const entryFile = await realpath(entryPath);
  const entryLoaderFile = await realpathKeepingCase(entryPath);
  const entryFolder = dirname(entryFile);

  const loadSource = async (file, loaderFile, kind, text, includes) => {
    const analysis = kind === 'module' ? analyzeSource(text, file, file === entryFile, hasBanner, includes) : null;
    const source = { file, loaderFile, kind, text, analysis, dependencies: [], includes };
    sources.set(file, source);
    if (analysis !== null) findings.push(...analysis.findings);
    if (kind === 'json') findings.push(...checkJsonFile(text, file));

    for (const record of analysis?.imports ?? []) {
      const resolved = await resolveImport(record, source, sources, entryFolder);
      if ('finding' in resolved) {
        findings.push(resolved.finding);
        continue;
      }
      source.dependencies.push({ record, target: resolved.file });
      if (sources.has(resolved.file)) continue;
      const importedText = record.kind === 'text' ? normalizeTextFile(resolved.content) : normalizeSourceText(resolved.content);
      await loadSource(resolved.file, resolved.loaderFile, record.kind, importedText, []);
    }
  };

  const entryRead = await readSourceFile(entryFile);
  const included = await includeParts(entryFile, normalizeSourceText(entryRead.content));
  if (!entryRead.isUtf8) findings.push(createFinding('source-encoding-invalid', 'The entry is not valid UTF-8', entryFile, included.text, 0));
  findings.push(...included.findings);
  await loadSource(entryFile, entryLoaderFile, 'module', included.text, included.includes);
  findings.push(...findPartModuleImports(sources, included.parts));
  return { sources, parts: included.parts, findings };
}

/**
 * Reads the part each directive names, and puts each part that passes its checks in place of its
 * directive's line. A refused directive's line stays in the text as a comment.
 * @param {string} entryFile The entry's real path.
 * @param {string} entryText The entry's own normalized text.
 * @returns {Promise<{ text: string, includes: IncludedPart[], parts: string[], findings: Finding[] }>}
 *   Each finding on the entry is placed in the expanded text, as the entry's analysis places its own.
 */
async function includeParts(entryFile, entryText) {
  const { directives, misplaced } = findDirectives(entryText);
  /** @type {DirectiveProblem[]} */
  const problems = misplaced.map(({ offset, message }) => ({ rule: 'include-misplaced', message, offset }));
  /** @type {PartReplacement[]} */
  const replacements = [];
  const parts = [];
  const findings = [];

  for (const directive of directives) {
    const read = await readPart(directive.path, dirname(entryFile));
    const addProblem = (rule, message) => problems.push({ rule, message, offset: directive.offset });
    if ('message' in read) {
      addProblem(read.rule, read.message);
    } else if (read.file === entryFile) {
      addProblem('include-twice', 'The directive names the entry');
    } else if (parts.includes(read.file)) {
      addProblem('include-twice', `The directive names ${JSON.stringify(directive.path)}, which an earlier directive names`);
    } else {
      const partFindings = checkPart(read.text, read.file);
      parts.push(read.file);
      findings.push(...partFindings);
      if (partFindings.length === 0) replacements.push({ file: read.file, text: read.text, start: directive.start, end: directive.end });
    }
  }

  const { text, includes } = expandParts(entryText, replacements);
  for (const { rule, message, offset } of problems) {
    findings.push(createFinding(rule, message, entryFile, text, findExpandedOffset(includes, offset)));
  }

  return { text, includes, parts, findings };
}

/**
 * The built script would run a part's code in the entry and again in the part's module scope.
 * @param {Map<string, LoadedSource>} sources
 * @param {string[]} parts The real path of each part.
 * @returns {Finding[]} One per module import that names a part, placed on the import in its importer.
 */
function findPartModuleImports(sources, parts) {
  const findings = [];

  for (const importer of sources.values()) {
    for (const { record, target } of importer.dependencies) {
      if (record.kind !== 'module' || !parts.includes(target)) continue;
      const message = `The specifier ${JSON.stringify(record.specifier)} names a part of the entry, so its code would run twice`;
      findings.push(createFinding('include-twice', message, importer.file, importer.text, record.offset));
    }
  }

  return findings;
}

/**
 * Refuses a path that names a part on some platforms only: one with a backslash, one with a root, and one
 * whose letter case differs from the file's, as resolveImport refuses such a specifier.
 * @param {string} path The path a directive names.
 * @param {string} entryFolder The real path of the entry's folder.
 * @returns {Promise<{ file: string, text: string } | { rule: string, message: string }>} The part's real path
 *   and normalized text, or the rule and the reason that refuse the directive.
 */
async function readPart(path, entryFolder) {
  const quotedPath = JSON.stringify(path);
  const notFound = (message) => ({ rule: 'include-not-found', message });
  let requestedFile = '';
  let file = '';
  let read = null;

  if (path === '') return notFound('The directive names no path');
  // Every file system call refuses a path that holds a NUL.
  if (path.includes('\0')) return notFound(`The path ${quotedPath} holds a NUL character`);
  if (path.includes('\\')) return notFound(`The path ${quotedPath} holds a backslash, which only Windows reads as a folder separator`);
  // The Windows root form also covers a POSIX root, and a drive letter such as the one in 'C:part.js'.
  if (win32.parse(path).root !== '') return notFound(`The path ${quotedPath} is not relative to the entry's folder`);

  try {
    requestedFile = resolve(entryFolder, path);
    file = await realpath(requestedFile);
    if (await hasOtherLetterCase(requestedFile, entryFolder)) return notFound(`The path ${quotedPath} differs in letter case from the file it names`);
    if (isAbsolute(relative(entryFolder, file))) return notFound(`The path ${quotedPath} names a file on another drive than the entry`);
    read = await readSourceFile(file);
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) return notFound(`No file exists at ${quotedPath}`);
    if (error.code === 'EISDIR') return notFound(`The path ${quotedPath} names a folder`);
    throw error;
  }
  if (!read.isUtf8) return { rule: 'source-encoding-invalid', message: `The path ${quotedPath} names a file that is not valid UTF-8` };
  return { file, text: normalizeSourceText(read.content) };
}

/**
 * Resolves a specifier as a URL against the importing file's loader path, as an ES module import does, and
 * reads the file.
 * @param {ImportRecord} record
 * @param {LoadedSource} importer
 * @param {Map<string, LoadedSource>} loadedSources The sources read so far, keyed by real path.
 * @param {string} entryFolder The real path of the entry's folder.
 * @returns {Promise<{ file: string, loaderFile: string, content: string } | { finding: Finding }>} `content`
 *   is the file's text as read, before normalization.
 */
async function resolveImport(record, importer, loadedSources, entryFolder) {
  const quotedSpecifier = JSON.stringify(record.specifier);
  const report = (rule, message) => ({ finding: createFinding(rule, message, importer.file, importer.text, record.offset) });
  const reportNotFound = (message) => report('import-not-found', message);
  let url = null;
  let requestedFile = '';
  let spelledFile = '';
  let file = '';
  let loaderFile = '';
  let read = null;

  try {
    url = new URL(record.specifier, pathToFileURL(importer.loaderFile));
    requestedFile = fileURLToPath(url);
    // Resolved against the importer's real path, so the spelling of its loader path cannot count as a letter case difference.
    spelledFile = fileURLToPath(new URL(record.specifier, pathToFileURL(importer.file)));
  } catch (error) {
    // fileURLToPath throws a URIError for a malformed percent escape, such as the one in './100%.js'.
    if (!(error instanceof URIError) && error.code !== 'ERR_INVALID_FILE_URL_PATH') throw error;
    return reportNotFound(`The specifier ${quotedSpecifier} names no file path`);
  }
  if (url.search !== '' || url.hash !== '') return reportNotFound(`The specifier ${quotedSpecifier} holds a query or a fragment`);
  // An encoded NUL, as in './a%00.js', decodes into a path that every file system call refuses.
  if (requestedFile.includes('\0')) return reportNotFound(`The specifier ${quotedSpecifier} names no file path`);

  try {
    file = await realpath(requestedFile);
    loaderFile = await realpathKeepingCase(requestedFile);
    if (await hasOtherLetterCase(spelledFile, dirname(importer.file))) {
      return reportNotFound(`The specifier ${quotedSpecifier} differs in letter case from the file it names`);
    }
    const loadedSource = loadedSources.get(file);
    if (loadedSource !== undefined && loadedSource.loaderFile !== loaderFile) {
      return reportNotFound(`The specifier ${quotedSpecifier} names a file already read under another path, which an ES module would load a second time`);
    }
    if (loadedSource !== undefined && loadedSource.kind !== record.kind) {
      const [readKind, importKind] = [SOURCE_KIND_NAMES[loadedSource.kind], SOURCE_KIND_NAMES[record.kind]];
      return report('import-kind-conflict', `The specifier ${quotedSpecifier} names a ${readKind} of this build, which this import reads as a ${importKind}`);
    }
    if (isAbsolute(relative(entryFolder, file))) {
      return reportNotFound(`The specifier ${quotedSpecifier} names a file on another drive than the entry`);
    }
    read = await readSourceFile(file);
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) return reportNotFound(`No file exists at ${quotedSpecifier}`);
    if (error.code === 'EISDIR') return reportNotFound(`The specifier ${quotedSpecifier} names a folder`);
    throw error;
  }
  if (!read.isUtf8) return report('source-encoding-invalid', `The specifier ${quotedSpecifier} names a file that is not valid UTF-8`);
  return { file, loaderFile, content: read.content };
}

/**
 * @param {string} file
 * @returns {Promise<{ content: string, isUtf8: boolean }>} `content` is the file's text as readFile decodes
 *   it, which holds U+FFFD for each byte sequence that is not UTF-8.
 */
async function readSourceFile(file) {
  const bytes = await readFile(file);

  try {
    return { content: STRICT_UTF8_DECODER.decode(bytes), isUtf8: true };
  } catch (error) {
    if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error;
    return { content: bytes.toString('utf8'), isUtf8: false };
  }
}

/**
 * Whether the spelled path spells a folder or file name in another letter case than its folder lists it.
 * The names the spelled path shares with the real folder path hold the spelling on disk, so they do not
 * count. It compares each name the path spells with its folder's
 * listing, so a link whose stored target differs in case from the folder on disk does not count either.
 * A name that the listing holds in no letter case, such as a Windows short name, does not count.
 * @param {string} spelledFile The absolute path of an existing file, as a specifier or a directive spells it.
 * @param {string} realFolder The real path of the folder the spelled path was resolved against.
 * @returns {Promise<boolean>}
 */
async function hasOtherLetterCase(spelledFile, realFolder) {
  const realSegments = realFolder.split(sep);
  const spelledSegments = spelledFile.split(sep);
  let sharedCount = 0;
  let names = [];

  while (sharedCount < realSegments.length && spelledSegments[sharedCount] === realSegments[sharedCount]) sharedCount += 1;

  for (let index = sharedCount; index < spelledSegments.length; index += 1) {
    const segment = spelledSegments[index];
    try {
      // The trailing separator makes a drive letter name its root, not its working directory.
      names = await readdir(`${spelledSegments.slice(0, index).join(sep)}${sep}`);
    } catch (error) {
      // Above a subst drive's root, the importer's real path reaches another folder than its loader path.
      if (MISSING_FILE_CODES.has(error.code)) return false;
      // A folder that may be passed through but not listed holds no evidence of a letter case difference.
      if (UNLISTABLE_FOLDER_CODES.has(error.code)) continue;
      throw error;
    }
    if (!names.includes(segment) && names.some((name) => name.toLowerCase() === segment.toLowerCase())) return true;
  }

  return false;
}
