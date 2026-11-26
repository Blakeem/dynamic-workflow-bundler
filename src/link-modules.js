import { BUILD_GLOBAL_READERS, SOURCE_KIND_NAMES } from './analyze-source.js';
import { createFinding } from './finding.js';

/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./load-sources.js').LoadedSource} LoadedSource */

// A module with one of these findings has exports the analysis could not read.
const UNKNOWN_EXPORT_RULES = new Set(['syntax-error', 'source-too-deep', 'export-from']);

/**
 * Orders the sources as ES modules evaluate: depth first in import order, each source after the files
 * it imports. Also reports each import cycle, each imported name that its module does not export, each
 * name a module reads that resolves to an entry declaration in the built script, and each entry
 * declaration of a global that the code the build adds for this build's sources reads.
 * @param {Map<string, LoadedSource>} sources Keyed by real path.
 * @param {string} entryFile
 * @param {(file: string) => string} formatSourcePath
 * @returns {{ order: string[], findings: Finding[] }} `order` holds the real paths of the sources, without the entry.
 */
export function linkModules(sources, entryFile, formatSourcePath) {
  const order = [];
  const findings = [];
  const isDoneByFile = new Map();
  const activeFiles = [];

  const visit = (file) => {
    const source = sources.get(file);
    isDoneByFile.set(file, false);
    activeFiles.push(file);

    for (const { record, target } of source.dependencies) {
      if (isDoneByFile.get(target) === false) {
        const cycle = [...activeFiles.slice(activeFiles.indexOf(target)), target].map(formatSourcePath).join(' -> ');
        findings.push(createFinding('import-cycle', `Modules import each other in a cycle: ${cycle}`, file, source.text, record.offset));
      } else if (!isDoneByFile.has(target)) {
        visit(target);
      }
    }

    activeFiles.pop();
    isDoneByFile.set(file, true);
    if (file !== entryFile) order.push(file);
  };

  visit(entryFile);
  findings.push(...findMissingExports(sources, entryFile, formatSourcePath));
  findings.push(...findEntryNameReads(sources, entryFile));
  findings.push(...findBuildGlobalDeclarations(sources, entryFile));
  return { order, findings };
}

/**
 * The code the build adds for a module or a JSON file runs in the entry's top-level scope, so an entry
 * declaration of a global that this code reads would shadow the global.
 * @param {Map<string, LoadedSource>} sources
 * @param {string} entryFile
 * @returns {Finding[]}
 */
function findBuildGlobalDeclarations(sources, entryFile) {
  const entry = sources.get(entryFile);
  const builtKinds = new Set([...sources.values()].filter((source) => source.file !== entryFile).map((source) => source.kind));
  const findings = [];

  for (const { name, offset } of entry.analysis.buildGlobalDeclarations) {
    const readerKind = BUILD_GLOBAL_READERS[name];
    if (!builtKinds.has(readerKind)) continue;
    const message = `The entry declares ${name} at its top level, where the code the build adds for each ${SOURCE_KIND_NAMES[readerKind]} reads it`;
    findings.push(createFinding('reserved-name', message, entry.file, entry.text, offset));
  }

  return findings;
}

/**
 * Module scopes sit inside the entry's top-level scope, so a name that a module reads and does not declare
 * would resolve to an entry declaration of that name, where an ES module reads the global.
 * @param {Map<string, LoadedSource>} sources
 * @param {string} entryFile
 * @returns {Finding[]}
 */
function findEntryNameReads(sources, entryFile) {
  const entryNames = new Set(sources.get(entryFile).analysis.topLevelNames);
  const findings = [];

  for (const source of sources.values()) {
    for (const { name, offset } of source.analysis?.freeNames ?? []) {
      if (!entryNames.has(name)) continue;
      const message = `The module reads ${name}, which the entry declares at its top level`;
      findings.push(createFinding('module-reads-entry-name', message, source.file, source.text, offset));
    }
  }

  return findings;
}

/**
 * A missing export is a link error under ES module rules, where a destructured scope would give undefined.
 * @param {Map<string, LoadedSource>} sources
 * @param {string} entryFile
 * @param {(file: string) => string} formatSourcePath
 * @returns {Finding[]}
 */
function findMissingExports(sources, entryFile, formatSourcePath) {
  const findings = [];

  for (const source of sources.values()) {
    for (const { record, target } of source.dependencies) {
      const { analysis } = sources.get(target);
      // A text file and a JSON file have no analysis, and their one export is the default the import reads.
      if (target === entryFile || analysis === null) continue;
      const hasUnknownExports = analysis.findings.some((finding) => UNKNOWN_EXPORT_RULES.has(finding.rule));
      const exportedNames = new Set(analysis.exports.map((exportRecord) => exportRecord.exported));
      if (hasUnknownExports) continue;

      for (const binding of record.bindings) {
        if (binding.imported === null || exportedNames.has(binding.imported)) continue;
        const message = `${formatSourcePath(target)} has no export named ${binding.imported}`;
        findings.push(createFinding('import-not-exported', message, source.file, source.text, binding.offset));
      }
    }
  }

  return findings;
}
