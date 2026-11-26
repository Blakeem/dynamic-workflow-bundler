import { realpath as realpathByCallback } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { analyzeSource } from './analyze-source.js';
import { createFinding } from './finding.js';
import { normalizeSourceText } from './normalize-source-text.js';

/** @typedef {import('./analyze-source.js').ImportRecord} ImportRecord */
/** @typedef {import('./analyze-source.js').SourceAnalysis} SourceAnalysis */
/** @typedef {import('./finding.js').Finding} Finding */

/**
 * @typedef {object} Dependency
 * @property {ImportRecord} record
 * @property {string} target The real path of the imported module.
 */

/**
 * @typedef {object} LoadedSource
 * @property {string} file The real path, which identifies the source.
 * @property {string} loaderFile The path the Node.js module loader identifies the source by.
 * @property {string} text The normalized text.
 * @property {SourceAnalysis} analysis
 * @property {Dependency[]} dependencies The imports that name an existing file, in source order.
 */

/**
 * @typedef {object} LoadedGraph
 * @property {Map<string, LoadedSource>} sources Keyed by real path, in the order they were read, entry first.
 * @property {Finding[]} findings The findings of every source, and one per import that resolveImport refuses.
 */

/** The error codes of a file system call on a path that names no file. */
export const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR']);
const UNLISTABLE_FOLDER_CODES = new Set(['EACCES', 'EPERM']);

// The Node.js module loader uses the JavaScript fs.realpath, which keeps letter case and Windows short names where fs.promises.realpath does not.
const realpathKeepingCase = promisify(realpathByCallback);

/**
 * Reads the entry and every module that its imports reach.
 * Real paths identify a source. The Node.js module loader identifies a module by a path that keeps the
 * spelling of each specifier, such as its letter case or a Windows short name, and by its query and
 * fragment. So resolveImport refuses a specifier whose case differs from its file's, one that holds a query
 * or a fragment, and one that names a source already read under another loader path. It also refuses a
 * module on another drive than the entry, which the built script cannot name by a relative path.
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

  const loadSource = async (file, loaderFile, text, isEntry) => {
    const source = { file, loaderFile, text, analysis: analyzeSource(text, file, isEntry, hasBanner), dependencies: [] };
    sources.set(file, source);
    findings.push(...source.analysis.findings);

    for (const record of source.analysis.imports) {
      const resolved = await resolveImport(record, source, sources, entryFolder);
      if ('finding' in resolved) {
        findings.push(resolved.finding);
        continue;
      }
      source.dependencies.push({ record, target: resolved.file });
      if (!sources.has(resolved.file)) await loadSource(resolved.file, resolved.loaderFile, resolved.text, false);
    }
  };

  await loadSource(entryFile, entryLoaderFile, normalizeSourceText(await readFile(entryFile, 'utf8')), true);
  return { sources, findings };
}

/**
 * Resolves a specifier as a URL against the importing file's loader path, as an ES module import does, and
 * reads the file.
 * @param {ImportRecord} record
 * @param {LoadedSource} importer
 * @param {Map<string, LoadedSource>} loadedSources The sources read so far, keyed by real path.
 * @param {string} entryFolder The real path of the entry's folder.
 * @returns {Promise<{ file: string, loaderFile: string, text: string } | { finding: Finding }>}
 */
async function resolveImport(record, importer, loadedSources, entryFolder) {
  const quotedSpecifier = JSON.stringify(record.specifier);
  const reportNotFound = (message) => ({ finding: createFinding('import-not-found', message, importer.file, importer.text, record.offset) });
  let url = null;
  let requestedFile = '';
  let file = '';
  let loaderFile = '';

  try {
    url = new URL(record.specifier, pathToFileURL(importer.loaderFile));
    requestedFile = fileURLToPath(url);
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
    if (await hasOtherLetterCase(record.specifier, importer)) {
      return reportNotFound(`The specifier ${quotedSpecifier} differs in letter case from the file it names`);
    }
    const loadedSource = loadedSources.get(file);
    if (loadedSource !== undefined && loadedSource.loaderFile !== loaderFile) {
      return reportNotFound(`The specifier ${quotedSpecifier} names a file already read under another path, which an ES module would load a second time`);
    }
    if (isAbsolute(relative(entryFolder, file))) {
      return reportNotFound(`The specifier ${quotedSpecifier} names a file on another drive than the entry`);
    }
    return { file, loaderFile, text: normalizeSourceText(await readFile(file, 'utf8')) };
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) return reportNotFound(`No file exists at ${quotedSpecifier}`);
    if (error.code === 'EISDIR') return reportNotFound(`The specifier ${quotedSpecifier} names a folder`);
    throw error;
  }
}

/**
 * Whether the specifier spells a folder or file name in another letter case than its folder lists it.
 * It resolves against the importer's real path, so the spelling of the importer's loader path, such as a
 * lowercase drive letter, does not count. It compares each name the specifier spells with its folder's
 * listing, so a link whose stored target differs in case from the folder on disk does not count either.
 * A name that the listing holds in no letter case, such as a Windows short name, does not count.
 * @param {string} specifier A specifier that names an existing file.
 * @param {LoadedSource} importer
 * @returns {Promise<boolean>}
 */
async function hasOtherLetterCase(specifier, importer) {
  const importerSegments = dirname(importer.file).split(sep);
  const spelledSegments = fileURLToPath(new URL(specifier, pathToFileURL(importer.file))).split(sep);
  let sharedCount = 0;
  let names = [];

  // The shared leading segments come from the importer's real path, which holds the spelling on disk.
  while (sharedCount < importerSegments.length && spelledSegments[sharedCount] === importerSegments[sharedCount]) sharedCount += 1;

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
