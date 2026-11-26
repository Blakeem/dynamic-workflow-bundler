import { createFinding } from './finding.js';

/** @typedef {import('./finding.js').Finding} Finding */
/** @typedef {import('./load-sources.js').LoadedSource} LoadedSource */

// A module with one of these findings has exports the analysis could not read.
const UNKNOWN_EXPORT_RULES = new Set(['syntax-error', 'export-from']);

/**
 * Orders the modules as ES modules evaluate: depth first in import order, each module after the modules
 * it imports. Also reports each import cycle, each imported name that its module does not export, and
 * each name a module reads that resolves to an entry declaration in the built script.
 * @param {Map<string, LoadedSource>} sources Keyed by real path.
 * @param {string} entryFile
 * @param {(file: string) => string} formatSourcePath
 * @returns {{ order: string[], findings: Finding[] }} `order` holds the real paths of the modules, without the entry.
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
  return { order, findings };
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
    for (const { name, offset } of source.analysis.freeNames) {
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
      const targetSource = sources.get(target);
      const hasUnknownExports = targetSource.analysis.findings.some((finding) => UNKNOWN_EXPORT_RULES.has(finding.rule));
      const exportedNames = new Set(targetSource.analysis.exports.map((exportRecord) => exportRecord.exported));
      if (target === entryFile || hasUnknownExports) continue;

      for (const binding of record.bindings) {
        if (binding.imported === '*' || exportedNames.has(binding.imported)) continue;
        const message = `${formatSourcePath(target)} has no export named ${binding.imported}`;
        findings.push(createFinding('import-not-exported', message, source.file, source.text, binding.offset));
      }
    }
  }

  return findings;
}
