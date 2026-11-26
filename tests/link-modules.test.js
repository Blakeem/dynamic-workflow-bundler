import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeSource } from '../src/analyze-source.js';
import { linkModules } from '../src/link-modules.js';

const FOLDER = '/work/';
const ENTRY_FILE = `${FOLDER}entry.js`;

/**
 * Builds the sources that loadSources would read, with each `./<name>` specifier naming `/work/<name>`.
 * @param {Record<string, string>} texts The entry's text under `entry.js`, then each module's text by its name.
 */
function makeSources(texts) {
  const sources = new Map();

  for (const [name, text] of Object.entries(texts)) {
    const file = `${FOLDER}${name}`;
    const analysis = analyzeSource(text, file, file === ENTRY_FILE, true);
    const dependencies = analysis.imports.map((record) => ({ record, target: `${FOLDER}${record.specifier.slice(2)}` }));
    sources.set(file, { file, text, analysis, dependencies });
  }

  return sources;
}

/**
 * @param {Record<string, string>} texts
 * @returns {string[]} Each finding as `<rule> <file name>:<line>`.
 */
function listFindings(texts) {
  const { findings } = linkModules(makeSources(texts), ENTRY_FILE, (file) => file);
  return findings.map((finding) => `${finding.rule} ${finding.file.slice(FOLDER.length)}:${finding.line}`);
}

describe('linkModules', () => {
  it('orders the modules depth first, each after the modules it imports', () => {
    const sources = makeSources({
      'entry.js': "export const meta = {};\nimport './a.js';\nimport './c.js';\n",
      'a.js': "import './b.js';\n",
      'b.js': "import './c.js';\n",
      'c.js': 'log(1);\n',
    });

    assert.deepEqual(linkModules(sources, ENTRY_FILE, (file) => file).order, ['/work/c.js', '/work/b.js', '/work/a.js']);
  });

  it('reports import-cycle for modules that import each other and not for a shared module', () => {
    const entry = "export const meta = {};\nimport './a.js';\nimport './b.js';\n";

    assert.deepEqual(listFindings({ 'entry.js': entry, 'a.js': "import './b.js';\n", 'b.js': "import './a.js';\n" }), ['import-cycle b.js:1']);
    assert.deepEqual(listFindings({ 'entry.js': entry, 'a.js': "import './b.js';\n", 'b.js': 'log(1);\n' }), []);
  });

  it('reports import-not-exported for a name the module does not export', () => {
    const module = 'export const a = 1;\n';

    assert.deepEqual(listFindings({ 'entry.js': "export const meta = {};\nimport { b } from './a.js';\n", 'a.js': module }), ['import-not-exported entry.js:2']);
    assert.deepEqual(listFindings({ 'entry.js': "export const meta = {};\nimport { a } from './a.js';\n", 'a.js': module }), []);
  });

  it('reports module-reads-entry-name for a free name that the entry declares, and not for a global', () => {
    const entry = "export const meta = {};\nimport { read } from './a.js';\nconst phaseName = 1;\n";

    assert.deepEqual(listFindings({ 'entry.js': entry, 'a.js': 'export function read() {\n  return phaseName;\n}\n' }), ['module-reads-entry-name a.js:2']);
    assert.deepEqual(listFindings({ 'entry.js': entry, 'a.js': 'export function read(phaseName) {\n  return [phaseName, log];\n}\n' }), []);
  });
});
