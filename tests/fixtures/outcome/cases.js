import { join } from 'node:path';
import { SCRIPT_BYTE_LIMIT } from '../../../src/check-contract.js';

/**
 * @typedef {object} OutcomeCase
 * @property {string} name
 * @property {Record<string, string | Buffer | ((folder: string) => string)>} files The files by path. A function
 *   takes the absolute path of the case's folder.
 * @property {string[]} args The command's arguments, run in the case's folder.
 * @property {0 | 1 | 2} exit
 * @property {string} [rule] For exit code 1, the rule id of the first finding.
 * @property {RegExp} [message] A pattern that the command's output matches.
 */

const BUILD_ARGS = ['build', 'entry.js', '--out', 'out/built.js'];
const META = "export const meta = { name: 'p', description: 'p' };\n";
const MODULE_PACKAGE = '{"type":"module"}';
const REQUIRE_ENTRY = `${META}const loaded = require('x');\nreturn loaded;\n`;
const REQUIRE_SCRIPT = `${META}// Built by dynamic-workflow-bundler from ../entry.js. Edit the source, not this file.\nconst loaded = require('x');\nreturn loaded;\n`;
const IMPORT_CHAIN_LENGTH = 400;

/**
 * @param {string} name
 * @param {OutcomeCase['files']} files
 * @param {Omit<OutcomeCase, 'name' | 'files'>} outcome
 * @returns {OutcomeCase}
 */
const createCase = (name, files, outcome) => ({ name, files, ...outcome });

/** @param {string} rule */
const buildFinding = (rule) => ({ args: BUILD_ARGS, exit: /** @type {const} */ (1), rule });
const BUILT = { args: BUILD_ARGS, exit: /** @type {const} */ (0) };
const CONFIG_USAGE_ERROR = { args: ['build'], exit: /** @type {const} */ (2) };
const VALIDATE_ARGS = ['validate', 'x.js'];
/** @param {string} rule */
const validateFinding = (rule) => ({ args: VALIDATE_ARGS, exit: /** @type {const} */ (1), rule });
const VALIDATED = { args: VALIDATE_ARGS, exit: /** @type {const} */ (0) };

/** @returns {Record<string, string>} An entry that imports a chain of modules, each of which imports the next. */
function createImportChain() {
  const files = { 'entry.js': `${META}import './m0.js';\n` };
  for (let index = 0; index < IMPORT_CHAIN_LENGTH; index += 1) {
    files[`m${index}.js`] = index < IMPORT_CHAIN_LENGTH - 1 ? `import './m${index + 1}.js';\n` : 'export const end = 1;\n';
  }
  return files;
}

/**
 * @param {string} field One more field of the config file's one workflow, in source form.
 * @returns {string} A config file whose one workflow builds entry.js to out/built.js.
 */
function formatConfig(field) {
  return `export default { workflows: [{ entry: 'entry.js', out: 'out/built.js', ${field} }] };\n`;
}

/**
 * @param {string} folder
 * @returns {string} A built script whose banner names the case's entry by its absolute path.
 */
function formatAbsoluteBannerScript(folder) {
  const entry = join(folder, 'entry.js').split('\\').join('/');
  return `${META}// Built by dynamic-workflow-bundler from ${entry}. Edit the source, not this file.\nreturn 1;\n`;
}

/** @type {OutcomeCase[]} */
export const OUTCOME_CASES = [
  createCase('empty entry', { 'entry.js': '' }, buildFinding('meta-not-first')),
  createCase('entry of blank lines', { 'entry.js': '\n\n' }, buildFinding('meta-not-first')),
  createCase('entry with only meta, no line break', { 'entry.js': META.trimEnd() }, BUILT),
  createCase('entry with BOM and CRLF', { 'entry.js': `\uFEFF${META.replace(/\n/g, '\r\n')}return 1;\r\n` }, BUILT),
  createCase('entry with CR only line breaks', { 'entry.js': `${META.replace(/\n/g, '\r')}return 1;\r` }, BUILT),
  createCase('entry is binary', { 'entry.js': Buffer.from([0, 159, 146, 150, 255, 254, 0, 0]) }, buildFinding('source-encoding-invalid')),
  createCase('entry with NUL inside', { 'entry.js': `${META}const a = "x\u0000y";\nreturn a;\n` }, BUILT),
  createCase('meta is not an object', { 'entry.js': 'export const meta = 5;\nreturn 1;\n' }, buildFinding('meta-not-first')),
  createCase('meta with spread', { 'entry.js': 'const base = {};\nexport const meta = { ...base };\n' }, buildFinding('meta-not-first')),
  createCase('meta declared twice', { 'entry.js': `${META}const meta = 2;\n` }, buildFinding('syntax-error')),
  createCase('meta as let', { 'entry.js': 'export let meta = {};\nreturn 1;\n' }, buildFinding('meta-not-first')),
  createCase('meta with two declarators', { 'entry.js': 'export const meta = {}, other = 1;\nreturn other;\n' }, buildFinding('meta-not-first')),
  createCase('entry with hashbang', { 'entry.js': `#!/usr/bin/env node\n${META}return 1;\n` }, BUILT),
  createCase('entry imports itself', { 'entry.js': `${META}import './entry.js';\n` }, buildFinding('import-cycle')),
  createCase('module imports the entry', { 'entry.js': `${META}import './a.js';\n`, 'a.js': "import './entry.js';\n" }, buildFinding('import-cycle')),
  createCase('import of a folder', { 'entry.js': `${META}import './lib.js';\n`, 'lib.js/x.txt': 'x' }, buildFinding('import-not-found')),
  createCase('import with backslash', { 'entry.js': `${META}import '.\\\\a.js';\n`, 'a.js': 'export const a = 1;\n' }, buildFinding('import-not-relative')),
  createCase('import with unicode name', { 'entry.js': `${META}import { a } from './ünï-名.js';\nreturn a;\n`, 'ünï-名.js': 'export const a = 1;\n' }, BUILT),
  createCase('import with space and hash in name', { 'entry.js': `${META}import { a } from './a b%23.js';\nreturn a;\n`, 'a b#.js': 'export const a = 1;\n' }, BUILT),
  createCase('import with empty specifier', { 'entry.js': `${META}import '';\n` }, buildFinding('import-not-relative')),
  createCase('import of ./', { 'entry.js': `${META}import './';\n` }, buildFinding('import-not-found')),
  createCase('import of the parent folder', { 'entry.js': `${META}import './..';\n` }, buildFinding('import-not-found')),
  createCase('import with unknown attribute', { 'entry.js': `${META}import a from './a.txt' with { type: 'css' };\n`, 'a.txt': 'x' }, buildFinding('import-attribute-unknown')),
  createCase('import with two attributes', { 'entry.js': `${META}import a from './a.txt' with { type: 'text', mode: 'x' };\n`, 'a.txt': 'x' }, buildFinding('import-attribute-unknown')),
  createCase('text file that is binary', { 'entry.js': `${META}import a from './a.bin';\nreturn a;\n`, 'a.bin': Buffer.from([255, 254, 0, 1, 2]) }, buildFinding('source-encoding-invalid')),
  createCase('text file empty', { 'entry.js': `${META}import a from './a.txt';\nreturn a;\n`, 'a.txt': '' }, BUILT),
  createCase('text file with only escapes', { 'entry.js': `${META}import a from './a.txt';\nreturn a;\n`, 'a.txt': '`${\\`\\${\\\\' }, BUILT),
  createCase('text file with CR only and NUL', { 'entry.js': `${META}import a from './a.txt';\nreturn a;\n`, 'a.txt': 'a\rb\u0000c\u2028d' }, BUILT),
  createCase('json empty', { 'entry.js': `${META}import a from './a.json';\nreturn a;\n`, 'a.json': '' }, buildFinding('json-invalid')),
  createCase('json with BOM', { 'entry.js': `${META}import a from './a.json';\nreturn a;\n`, 'a.json': '\uFEFF{ "a": 1 }' }, BUILT),
  createCase('json with duplicate and __proto__ keys', { 'entry.js': `${META}import a from './a.json';\nreturn a;\n`, 'a.json': '{ "__proto__": 1, "a": 1, "a": 2 }' }, BUILT),
  createCase('json deep nesting', { 'entry.js': `${META}import a from './a.json';\nreturn a;\n`, 'a.json': `${'['.repeat(5000)}${']'.repeat(5000)}` }, BUILT),
  createCase('json as a module import of text type', { 'entry.js': `${META}import a from './a.json' with { type: 'text' };\nreturn a;\n`, 'a.json': 'not json' }, BUILT),
  createCase('include of itself', { 'entry.js': `${META}// @include ./entry.js\n` }, buildFinding('include-twice')),
  createCase('include of a folder', { 'entry.js': `${META}// @include ./parts\n`, 'parts/x.js': '1;\n' }, buildFinding('include-not-found')),
  createCase('include with no path', { 'entry.js': `${META}// @include\n` }, buildFinding('include-not-found')),
  createCase('include with spaces in path', { 'entry.js': `${META}// @include ./my part.js\n`, 'my part.js': 'const a = 1;\n' }, BUILT),
  createCase('include of an empty part', { 'entry.js': `${META}// @include ./p.js\nreturn 1;\n`, 'p.js': '' }, BUILT),
  createCase('include of a part with an unclosed block', { 'entry.js': `${META}// @include ./p.js\n}\n`, 'p.js': 'if (true) {\n' }, buildFinding('syntax-error')),
  createCase('include of a part ending in a line comment, no line break', { 'entry.js': `${META}// @include ./p.js\nreturn 1;\n`, 'p.js': 'const a = 1; // tail' }, BUILT),
  createCase('include of a part ending inside a template', { 'entry.js': `${META}// @include ./p.js\n\`;\n`, 'p.js': 'const a = `open\n' }, buildFinding('syntax-error')),
  createCase('include path that escapes upward', { 'entry.js': `${META}// @include ../../../../../../nope.js\n` }, buildFinding('include-not-found')),
  createCase('include a module file', { 'entry.js': `${META}import { a } from './a.js';\n// @include ./a.js\n`, 'a.js': 'export const a = 1;\n' }, buildFinding('include-twice')),
  createCase('long import chain', createImportChain(), BUILT),
  createCase('out is the entry', { 'entry.js': META }, { args: ['build', 'entry.js', '--out', 'entry.js'], exit: 2 }),
  createCase('out is a folder', { 'entry.js': META, 'out/x.txt': 'x' }, { args: ['build', 'entry.js', '--out', 'out'], exit: 2 }),
  createCase('entry that reads require', { 'entry.js': REQUIRE_ENTRY }, buildFinding('global-undefined')),
  createCase('entry that reads require, with --no-validate', { 'entry.js': REQUIRE_ENTRY }, { args: [...BUILD_ARGS, '--no-validate'], exit: 0 }),
  createCase('config workflow with validate: false whose entry reads require', { 'dwfb.config.js': formatConfig('validate: false'), 'package.json': MODULE_PACKAGE, 'entry.js': REQUIRE_ENTRY }, { args: ['build'], exit: 0 }),
  createCase(
    'config workflow with validate: \'no\'',
    { 'dwfb.config.js': formatConfig("validate: 'no'"), 'package.json': MODULE_PACKAGE, 'entry.js': META },
    { ...CONFIG_USAGE_ERROR, message: /takes validate as a boolean\.\n$/ },
  ),
  createCase('check of a fresh script that reads require', { 'entry.js': REQUIRE_ENTRY, 'out/built.js': REQUIRE_SCRIPT }, { args: [...BUILD_ARGS, '--check'], exit: 1, rule: 'global-undefined' }),
  createCase(
    'check of a fresh script that reads require, with --no-validate',
    { 'entry.js': REQUIRE_ENTRY, 'out/built.js': REQUIRE_SCRIPT },
    { args: [...BUILD_ARGS, '--check', '--no-validate'], exit: 0, message: /^out\/built\.js matches its source\.\n$/ },
  ),
  createCase('config is not an object', { 'dwfb.config.js': 'export default 5;\n', 'package.json': MODULE_PACKAGE }, CONFIG_USAGE_ERROR),
  createCase('config throws', { 'dwfb.config.js': "throw new Error('boom');\n", 'package.json': MODULE_PACKAGE }, CONFIG_USAGE_ERROR),
  createCase('config has a syntax error', { 'dwfb.config.js': 'export default {\n', 'package.json': MODULE_PACKAGE }, CONFIG_USAGE_ERROR),
  createCase('config with no default export', { 'dwfb.config.js': 'export const workflows = [];\n', 'package.json': MODULE_PACKAGE }, CONFIG_USAGE_ERROR),
  createCase('config row with a number entry', { 'dwfb.config.js': 'export default { workflows: [{ entry: 5, out: "o.js" }] };\n', 'package.json': MODULE_PACKAGE }, CONFIG_USAGE_ERROR),
  createCase('config with a null row', { 'dwfb.config.js': 'export default { workflows: [null] };\n', 'package.json': MODULE_PACKAGE }, CONFIG_USAGE_ERROR),
  createCase(
    'config with a getter that throws',
    { 'dwfb.config.js': 'export default { get workflows() { throw new Error("x"); } };\n', 'package.json': MODULE_PACKAGE },
    { ...CONFIG_USAGE_ERROR, message: /The config file dwfb\.config\.js does not load\. x\./ },
  ),
  createCase('config as commonjs', { 'dwfb.config.js': 'module.exports = { workflows: [] };\n' }, CONFIG_USAGE_ERROR),
  createCase('no config file', {}, CONFIG_USAGE_ERROR),
  createCase('locate a script with no banner and no config', { 'x.js': `${META}return 1;\n` }, { args: ['locate', 'x.js', '2'], exit: 2 }),
  createCase('locate line zero', { 'x.js': `${META}return 1;\n` }, { args: ['locate', 'x.js', '0', '--entry', 'x.js'], exit: 2 }),
  createCase('locate a non-number line', { 'x.js': `${META}return 1;\n` }, { args: ['locate', 'x.js', 'abc'], exit: 2 }),
  createCase('locate a huge line', { 'x.js': `${META}return 1;\n` }, { args: ['locate', 'x.js', '99999999999999999999'], exit: 2 }),
  createCase(
    'locate a banner that names a missing entry',
    { 'x.js': `${META}// Built by dynamic-workflow-bundler from ../gone/entry.js. Edit the source, not this file.\nreturn 1;\n` },
    { args: ['locate', 'x.js', '2'], exit: 2 },
  ),
  createCase(
    'locate a banner with an absolute path',
    { 'entry.js': `${META}return 1;\n`, 'x.js': formatAbsoluteBannerScript },
    { args: ['locate', 'x.js', '2'], exit: 2, message: /names no relative path[^\n]*--entry <file>/ },
  ),
  createCase('locate a binary script', { 'x.js': Buffer.from([255, 254, 0, 1]) }, { args: ['locate', 'x.js', '1'], exit: 2 }),
  createCase('locate runtime line before the body', { 'entry.js': `${META}return 1;\n` }, { args: ['locate', 'entry.js', '0:1', '--runtime', '--entry', 'entry.js'], exit: 2 }),
  createCase('validate an empty file', { 'x.js': '' }, validateFinding('meta-not-first')),
  createCase('validate a file that holds only a comment', { 'x.js': '// only a comment\n' }, validateFinding('meta-not-first')),
  createCase('validate a file of only a byte order mark', { 'x.js': '\uFEFF' }, validateFinding('meta-not-first')),
  createCase('validate a binary file', { 'x.js': Buffer.from([0, 159, 146, 150, 255, 254, 0, 0]) }, validateFinding('syntax-error')),
  createCase(
    'validate a script with a NUL outside a string',
    { 'x.js': `${META}const a = 1;\u0000\n` },
    { ...validateFinding('syntax-error'), message: /^x\.js:2:13 syntax-error Unexpected character '\\u\{0000\}'\. / },
  ),
  createCase('validate a script with a byte that is not UTF-8 in a string', { 'x.js': Buffer.concat([Buffer.from(`${META}return '`), Buffer.from([255]), Buffer.from("';\n")]) }, VALIDATED),
  // U+FFFD cannot sit in a name, where the latin1 reading of 0xFF, ÿ, can.
  createCase('validate a script with a byte that is not UTF-8 in a name', { 'x.js': Buffer.concat([Buffer.from(`${META}const a`), Buffer.from([255]), Buffer.from(' = 1;\n')]) }, validateFinding('syntax-error')),
  createCase('validate a script with a byte order mark and CRLF', { 'x.js': `\uFEFF${META.replace(/\n/g, '\r\n')}return 1;\r\n` }, VALIDATED),
  createCase(
    'validate a script with CR only line breaks',
    { 'x.js': `${META.replace(/\n/g, '\r')}const a = 1;\rreturn Date.now();\r` },
    { ...validateFinding('clock-unavailable'), message: /^x\.js:3:8 clock-unavailable / },
  ),
  createCase('validate a script one byte past the size limit', { 'x.js': `${META}//${'a'.repeat(SCRIPT_BYTE_LIMIT - META.length - 2)}\n` }, validateFinding('script-too-large')),
  createCase('validate a folder', { 'x/x.js': META }, { args: ['validate', 'x'], exit: 2 }),
  createCase('validate a path that ends in a separator', { 'x.js': META }, { args: ['validate', 'x.js/'], exit: 2 }),
  createCase('validate a missing file', {}, { args: ['validate', 'x.js'], exit: 2 }),
  createCase('validate the working directory', {}, { args: ['validate', '.'], exit: 2 }),
  createCase('validate a path with a space', { 'my script.js': META }, { args: ['validate', 'my script.js'], exit: 0, message: /^my script\.js breaks no rule/ }),
  createCase('validate a script named -x.js after --', { '-x.js': META }, { args: ['validate', '--', '-x.js'], exit: 0 }),
  createCase('validate a script named -x.js', { '-x.js': META }, { args: ['validate', '-x.js'], exit: 2 }),
  createCase('validate the same script named twice', { 'x.js': META }, { args: ['validate', 'x.js', 'x.js'], exit: 0, message: /^x\.js breaks no rule[^\n]*\nx\.js breaks no rule[^\n]*\n$/ }),
  createCase('validate a script and --config', { 'x.js': META }, { args: ['validate', 'x.js', '--config', 'dwfb.config.js'], exit: 2 }),
  createCase('validate with no script and no config file', {}, { args: ['validate'], exit: 2 }),
  createCase(
    'validate a config file whose out is missing',
    { 'dwfb.config.js': 'export default { workflows: [{ entry: "entry.js", out: "out/built.js" }] };\n', 'package.json': MODULE_PACKAGE, 'entry.js': META },
    { args: ['validate'], exit: 2, message: /does not exist, so run dwfb build entry\.js\.\n$/ },
  ),
  createCase(
    'validate a config file whose out is built',
    { 'dwfb.config.js': 'export default { workflows: [{ entry: "entry.js", out: "out/built.js" }] };\n', 'package.json': MODULE_PACKAGE, 'entry.js': META, 'out/built.js': META },
    { args: ['validate'], exit: 0, message: /^out\/built\.js breaks no rule/ },
  ),
  createCase(
    'validate a config file whose workflow with validate: false has an out that reads require',
    { 'dwfb.config.js': formatConfig('validate: false'), 'package.json': MODULE_PACKAGE, 'entry.js': REQUIRE_ENTRY, 'out/built.js': REQUIRE_SCRIPT },
    { args: ['validate'], exit: 1, rule: 'global-undefined' },
  ),
];
