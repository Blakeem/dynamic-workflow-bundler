import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeSource } from '../src/analyze-source.js';
import { linkModules } from '../src/link-modules.js';

const FOLDER = '/work/';
const ENTRY_FILE = `${FOLDER}entry.js`;

/**
 * Builds the sources that loadSources would read, with each `./<name>` specifier naming `/work/<name>`.
 * A name that ends in `.json` is a JSON file, one that ends in `.md` a text file, and every other a module.
 * @param {Record<string, string>} texts The entry's text under `entry.js`, then each source's text by its name.
 */
function makeSources(texts) {
  const sources = new Map();

  for (const [name, text] of Object.entries(texts)) {
    const file = `${FOLDER}${name}`;
    const kind = name.endsWith('.json') ? 'json' : name.endsWith('.md') ? 'text' : 'module';
    const analysis = kind === 'module' ? analyzeSource(text, file, file === ENTRY_FILE, true) : null;
    const dependencies = (analysis?.imports ?? []).map((record) => ({ record, target: `${FOLDER}${record.specifier.slice(2)}` }));
    sources.set(file, { file, loaderFile: file, kind, text, analysis, dependencies, includes: [] });
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

  it('reports import-not-exported for the string export name "*" that the module does not export, and not for a namespace import', () => {
    const entry = "export const meta = {};\nimport { '*' as star } from './a.js';\nimport * as all from './a.js';\n";

    assert.deepEqual(listFindings({ 'entry.js': entry, 'a.js': 'export const a = 1;\n' }), ['import-not-exported entry.js:2']);
    assert.deepEqual(listFindings({ 'entry.js': entry, 'a.js': "const a = 1;\nexport { a as '*' };\n" }), []);
  });

  it('reports no import-not-exported for a module whose exports the parser could not read', () => {
    const depth = 1200;
    const deepModule = `export const a = ${'{ a: '.repeat(depth)}1${' }'.repeat(depth)};\n`;

    assert.deepEqual(listFindings({ 'entry.js': "export const meta = {};\nimport { a } from './a.js';\n", 'a.js': deepModule }), []);
  });

  it('reports module-reads-entry-name for a free name that the entry declares, and not for a global', () => {
    const entry = "export const meta = {};\nimport { read } from './a.js';\nconst phaseName = 1;\n";

    assert.deepEqual(listFindings({ 'entry.js': entry, 'a.js': 'export function read() {\n  return phaseName;\n}\n' }), ['module-reads-entry-name a.js:2']);
    assert.deepEqual(listFindings({ 'entry.js': entry, 'a.js': 'export function read(phaseName) {\n  return [phaseName, log];\n}\n' }), []);
  });

  it('names a joiner inside the name a module-reads-entry-name finding quotes by its JavaScript escape', () => {
    const entry = "export const meta = {};\nimport { read } from './a.js';\nconst phase\u200DName = 1;\n";
    const { findings } = linkModules(makeSources({ 'entry.js': entry, 'a.js': 'export const read = () => phase\u200DName;\n' }), ENTRY_FILE, (file) => file);

    assert.deepEqual(findings.map((finding) => finding.message), ['The module reads phase\\u{200D}Name, which the entry declares at its top level']);
  });

  it('reports no module-reads-entry-name for meta, which the script body does not bind', () => {
    const entry = "export const meta = {};\nimport { read } from './a.js';\n";

    assert.deepEqual(listFindings({ 'entry.js': entry, 'a.js': 'export const read = () => typeof meta;\n' }), []);
  });

  it('reports reserved-name for an entry declaration of a global that the code the build adds for this build\'s sources reads', () => {
    const entry = (imports) => `export const meta = {};\n${imports}const Object = 1;\nclass Symbol {}\nvar JSON;\n`;
    const module = 'log(1);\n';

    assert.deepEqual(listFindings({ 'entry.js': entry("import './a.js';\n"), 'a.js': module }), ['reserved-name entry.js:3', 'reserved-name entry.js:4']);
    assert.deepEqual(listFindings({ 'entry.js': entry("import a from './a.json';\n"), 'a.json': '1' }), ['reserved-name entry.js:5']);
    assert.deepEqual(listFindings({ 'entry.js': entry("import './a.js';\n"), 'a.js': "import a from './a.json';\n", 'a.json': '1' }), [
      'reserved-name entry.js:3',
      'reserved-name entry.js:4',
      'reserved-name entry.js:5',
    ]);
    assert.deepEqual(listFindings({ 'entry.js': entry("import a from './a.md';\n"), 'a.md': 'a' }), []);
    assert.deepEqual(listFindings({ 'entry.js': entry('') }), []);
  });

  it('skips a text file, which has no analysis, when it checks imported names', () => {
    const sources = makeSources({ 'entry.js': "export const meta = {};\nimport notes from './notes.md';\n", 'notes.md': 'n' });
    const notesFile = `${FOLDER}notes.md`;

    const { order, findings } = linkModules(sources, ENTRY_FILE, (file) => file);

    assert.deepEqual(findings, []);
    assert.deepEqual(order, [notesFile]);
  });
});
