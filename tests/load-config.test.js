import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from 'dynamic-workflow-bundler';
import { formatForwardSlashes } from '../src/display-path.js';
import { IS_MODULE_SYNTAX_DETECTED } from '../src/import-module-file.js';
import { READ_BYTE_LIMIT } from '../src/read-byte-limit.js';
import { writeSizedFile } from './support/write-sized-file.js';

const CONFIG_FIXTURES = fileURLToPath(new URL('./fixtures/config/', import.meta.url));

/**
 * Loads a config file in a child process, since a test that names paths relative to a working directory needs
 * its own working directory.
 * @param {string} cwd
 * @param {string} configFile
 * @returns {string} The message loadConfig rejected with, or '' when it loaded.
 */
function runLoadConfig(cwd, configFile) {
  const code = `import { loadConfig } from '${new URL('../src/index.js', import.meta.url).href}'; await loadConfig('${configFile}').catch((error) => process.stdout.write(error.message));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8' }).stdout;
}

/**
 * One fixture per usage error of a config file, each with the message its rejection holds.
 * @type {Record<string, RegExp>}
 */
const CONFIG_ERROR_FIXTURES = Object.freeze({
  'load-fails': /does not load\. [^\n]*\/load-fails\/dwfb\.config\.js:3:1 Unexpected token$/,
  'syntax-error': /does not load\. [^\n]*\/syntax-error\/dwfb\.config\.js:4:27 Unexpected token$/,
  'import-syntax-error': /does not load\. [^\n]*\/import-syntax-error\/rows\/review\.js:1:50 Unexpected token$/,
  'import-json-invalid': /does not load\. [^\n]*\/import-json-invalid\/workflows\.json:2:52 Expected a property name in double quotes$/,
  'throws-syntax-error': /does not load\. [^:\n]* in JSON at position 25\b[^:\n]*$/,
  'commonjs-package': /does not load\. Unexpected token 'export'\. If the file is an ES module, set "type": "module" in the nearest package\.json, or name a \.mjs config file with --config$/,
  'import-missing': /does not load\. Cannot find module '[^']*missing\.js' imported from [^\n]*dwfb\.config\.js$/,
  'default-missing': /does not export default an object of the form \{ workflows: \[\.\.\.\] \}$/,
  'default-not-object': /does not export default an object of the form \{ workflows: \[\.\.\.\] \}$/,
  'default-throws': /^The config file .*dwfb\.config\.js does not load\. The workflows list is not ready$/,
  'default-throws-no-text': /^The config file .*dwfb\.config\.js does not load\. Its code threw a value that has no text$/,
  'throws-no-text': /^The config file .*dwfb\.config\.js does not load\. Its code threw a value that has no text$/,
  'default-throws-empty-text': /^The config file .*dwfb\.config\.js does not load\. Its code threw a value that has no text$/,
  'throws-empty-text': /^The config file .*dwfb\.config\.js does not load\. Its code threw a value that has no text$/,
  'unknown-key': /has an unknown key watch$/,
  'workflows-not-list': /has no workflows list$/,
  'workflows-empty': /lists no workflow$/,
  'workflow-not-object': /^Workflow 2 of the config file .* is not an object of the form \{ entry, out, banner, validate, scenarios, map \}$/,
  'workflow-unknown-key': /^Workflow 1 of the config file .* has an unknown key output$/,
  'entry-missing': /^Workflow 1 of the config file .* needs entry, the path of an entry file$/,
  'out-not-string': /^Workflow 1 of the config file .* needs out, the path of the built script$/,
  'banner-not-boolean': /^Workflow 1 of the config file .* takes banner as a boolean$/,
  'out-twice': /^Workflows 1 and 3 of the config file .* both write \.\/dist\/\.\.\/dist\/out\.js$/,
});

/** @param {RegExp} pattern */
function isUsageError(pattern) {
  return (error) => error.name === 'UsageError' && pattern.test(error.message);
}

describe('loadConfig', () => {
  it('resolves to the checked config with absolute paths', async () => {
    const folder = join(CONFIG_FIXTURES, 'project');

    const config = await loadConfig(relative(process.cwd(), join(folder, 'dwfb.config.js')));

    assert.deepEqual(config, {
      workflows: [
        { entry: join(folder, 'workflows', 'review', 'entry.js'), out: join(folder, 'dist', 'review.js'), banner: true, validate: true, scenarios: null, map: null },
        { entry: join(folder, 'workflows', 'summary', 'entry.js'), out: join(folder, 'dist', 'summary.js'), banner: false, validate: true, scenarios: null, map: null },
      ],
    });
  });

  it('rejects each config fixture with the usage error it holds', async () => {
    for (const [name, pattern] of Object.entries(CONFIG_ERROR_FIXTURES)) {
      await assert.rejects(loadConfig(join(CONFIG_FIXTURES, name, 'dwfb.config.js')), isUsageError(pattern), name);
    }
  });

  it('names each file of a load failure by its path relative to the working directory', async () => {
    const folder = formatForwardSlashes(relative(process.cwd(), join(CONFIG_FIXTURES, 'import-missing')));

    await assert.rejects(
      loadConfig(join(CONFIG_FIXTURES, 'import-missing', 'dwfb.config.js')),
      (error) => error.message.endsWith(`Cannot find module '${folder}/missing.js' imported from ${folder}/dwfb.config.js`),
    );
  });

  it('names a UNC path, a \\\\?\\UNC\\ path and a file URL with a host by its path relative to a working directory on a UNC share', async (context) => {
    if (process.platform !== 'win32') return context.skip('only Windows names a UNC share');
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const shareFolder = `\\\\127.0.0.1\\${folder[0]}$${folder.slice(2)}`;
    const configText = String.raw`const sep = '\\';
const cwd = process.cwd();
throw new Error(['a', cwd + sep + 'a.js', 'b', sep + sep + '?' + sep + 'UNC' + cwd.slice(1) + sep + 'b.js', 'c', new URL('c.js', import.meta.url).href, 'd'].join(' '));
`;

    try {
      if (!existsSync(shareFolder)) return context.skip('this machine shares no drive as an administrative share');
      await writeFile(join(folder, 'dwfb.config.mjs'), configText);
      assert.equal(runLoadConfig(shareFolder, 'dwfb.config.mjs'), 'The config file dwfb.config.mjs does not load. a a.js b b.js c c.js d');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names each file of a load failure by its entire path when a folder name holds a space', async () => {
    const parentFolder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const folder = join(parentFolder, 'my project');
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await mkdir(folder);
      await writeFile(join(folder, 'dwfb.config.mjs'), "import './missing.js';\n\nexport default { workflows: [] };\n");
      await assert.rejects(
        loadConfig(join(folder, 'dwfb.config.mjs')),
        (error) => error.message.endsWith(`Cannot find module '${displayFolder}/missing.js' imported from ${displayFolder}/dwfb.config.mjs`),
      );
    } finally {
      await rm(parentFolder, { recursive: true, force: true });
    }
  });

  it('names the line of a syntax error in a config file that loads as CommonJS, and follows none of its imports', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await writeFile(join(folder, 'package.json'), '{ "type": "commonjs" }\n');
      await writeFile(join(folder, 'broken.js'), 'module.exports = { workflows: [ };\n');
      await writeFile(join(folder, 'module-broken.js'), 'export default { workflows: [ };\n');
      await writeFile(join(folder, 'imports.js'), "import './bad.js';\n\nexport default { workflows: [] };\n");
      await writeFile(join(folder, 'bad.js'), 'export const x = ;\n');
      await assert.rejects(loadConfig(join(folder, 'broken.js')), (error) => error.message.endsWith(`does not load. ${displayFolder}/broken.js:1:33 Unexpected token`));
      await assert.rejects(loadConfig(join(folder, 'module-broken.js')), isUsageError(/does not load\. Unexpected token 'export'\. If the file is an ES module, set "type": "module"/));
      await assert.rejects(loadConfig(join(folder, 'imports.js')), isUsageError(/does not load\. Cannot use import statement outside a module\. If the file is an ES module, set "type": "module"/));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('gives the cause a CommonJS config file throws as it runs, with no syntax error of its CommonJS code and no "type": "module" hint', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));

    try {
      await writeFile(join(folder, 'package.json'), '{ "type": "commonjs" }\n');
      await writeFile(join(folder, 'dwfb.config.js'), "var package = require('./package.json');\nmodule.exports = { workflows: JSON.parse('{') };\n");
      await assert.rejects(loadConfig(join(folder, 'dwfb.config.js')), (error) => {
        assert.match(error.message, /does not load\. [^:\n]* in JSON at position 1\b[^:\n]*$/);
        assert.ok(!error.message.includes('"type": "module"'), error.message);
        return true;
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('parses a .js import of an ES config file that loads as CommonJS as CommonJS', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));

    try {
      await mkdir(join(folder, 'sub'));
      await writeFile(join(folder, 'sub', 'package.json'), '{ "type": "commonjs" }\n');
      await writeFile(join(folder, 'sub', 'a.js'), 'module.exports = 1;\nif (true) return;\n');
      await writeFile(join(folder, 'dwfb.config.mjs'), "import './sub/a.js';\n\nexport default { workflows: JSON.parse('{') };\n");
      await assert.rejects(loadConfig(join(folder, 'dwfb.config.mjs')), isUsageError(/does not load\. [^:\n]* in JSON at position 1\b[^:\n]*$/));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names the line of a syntax error in a config file of a package with no "type" that fails both parses, as Node reparses it as an ES module', { skip: !IS_MODULE_SYNTAX_DETECTED }, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await writeFile(join(folder, 'package.json'), '{ "private": true }\n');
      await writeFile(join(folder, 'dwfb.config.js'), 'export default { workflows: [ };\n');
      await assert.rejects(loadConfig(join(folder, 'dwfb.config.js')), (error) => error.message.endsWith(`does not load. ${displayFolder}/dwfb.config.js:1:31 Unexpected token`));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('searches a linked config file\'s imports in the folder of the link\'s target, as Node loads them', async (context) => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));

    try {
      await mkdir(join(folder, 'A'));
      await mkdir(join(folder, 'B'));
      await writeFile(join(folder, 'B', 'dwfb.config.mjs'), "import './helper.js';\n\nexport default { workflows: JSON.parse('{') };\n");
      await writeFile(join(folder, 'B', 'helper.js'), 'export const helper = 1;\n');
      await writeFile(join(folder, 'A', 'helper.js'), 'let let = 1;\n');
      try {
        await symlink(join('..', 'B', 'dwfb.config.mjs'), join(folder, 'A', 'dwfb.config.mjs'), 'file');
      } catch (error) {
        if (error.code === 'EPERM') return context.skip('this account cannot create a symbolic link');
        throw error;
      }
      await assert.rejects(loadConfig(join(folder, 'A', 'dwfb.config.mjs')), isUsageError(/does not load\. [^:\n]* in JSON at position 1\b[^:\n]*$/));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('finds the file that does not parse in the depth-first order Node loads, before an import Node never reached', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
      await writeFile(join(folder, 'dwfb.config.js'), "import './a.js';\nimport './b.js';\n\nexport default { workflows: [] };\n");
      await writeFile(join(folder, 'a.js'), "import './c.js';\n");
      await writeFile(join(folder, 'c.js'), "import './a.js';\nimport './bad.js';\n");
      await writeFile(join(folder, 'bad.js'), 'export const x = ;\n');
      await writeFile(join(folder, 'b.js'), "import './missing.js';\n");
      await assert.rejects(loadConfig(join(folder, 'dwfb.config.js')), (error) => error.message.endsWith(`does not load. ${displayFolder}/bad.js:1:18 Unexpected token`));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('reads an import of READ_BYTE_LIMIT bytes to find the syntax error, and names an import one byte larger with its size', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));
    const configText = "import './a.mjs';\n\nexport default { workflows: [] };\n";

    try {
      await mkdir(join(folder, 'limit'));
      await mkdir(join(folder, 'large'));
      await writeFile(join(folder, 'limit', 'dwfb.config.mjs'), configText);
      await writeFile(join(folder, 'large', 'dwfb.config.mjs'), configText);
      await writeSizedFile(join(folder, 'limit', 'a.mjs'), READ_BYTE_LIMIT);
      await writeSizedFile(join(folder, 'large', 'a.mjs'), READ_BYTE_LIMIT + 1);
      await assert.rejects(loadConfig(join(folder, 'limit', 'dwfb.config.mjs')), isUsageError(new RegExp(`does not load\\. ${displayFolder}/limit/a\\.mjs:1:1 Unexpected character '\\\\u\\{0000\\}'$`)));
      await assert.rejects(
        loadConfig(join(folder, 'large', 'dwfb.config.mjs')),
        isUsageError(new RegExp(`does not load\\. .+\\. The file ${displayFolder}/large/a\\.mjs is ${READ_BYTE_LIMIT + 1} bytes, which is more than the ${READ_BYTE_LIMIT} bytes dwfb reads, so the place of the syntax error is unknown$`)),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('passes an import larger than READ_BYTE_LIMIT to name the CommonJS file Node compiled, and names that file with its size when it is larger', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));
    const largeModuleText = `export const a = '${'a'.repeat(READ_BYTE_LIMIT)}';\n`;
    const largeCommonJsText = `const = ;\n//${'a'.repeat(READ_BYTE_LIMIT)}\n`;

    try {
      await writeFile(join(folder, 'large.mjs'), largeModuleText);
      await writeFile(join(folder, 'small.cjs'), 'const = ;\n');
      await writeFile(join(folder, 'large.cjs'), largeCommonJsText);
      await writeFile(join(folder, 'imports-small.mjs'), "import './large.mjs';\nimport './small.cjs';\n\nexport default { workflows: [] };\n");
      await writeFile(join(folder, 'imports-large.mjs'), "import './large.mjs';\nimport './large.cjs';\n\nexport default { workflows: [] };\n");
      await assert.rejects(loadConfig(join(folder, 'imports-small.mjs')), isUsageError(new RegExp(`does not load\\. ${displayFolder}/small\\.cjs:1:7 Unexpected token$`)));
      await assert.rejects(
        loadConfig(join(folder, 'imports-large.mjs')),
        isUsageError(new RegExp(`does not load\\. .+\\. The file ${displayFolder}/large\\.cjs is ${Buffer.byteLength(largeCommonJsText)} bytes, which is more than the ${READ_BYTE_LIMIT} bytes dwfb reads, so the place of the syntax error is unknown$`)),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names an ES module larger than READ_BYTE_LIMIT when the search reaches no CommonJS file that fails', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));
    const largeModuleText = `import './bad.cjs';\nexport const a = '${'a'.repeat(READ_BYTE_LIMIT)}';\n`;

    try {
      await writeFile(join(folder, 'large.mjs'), largeModuleText);
      await writeFile(join(folder, 'bad.cjs'), 'const = ;\n');
      await writeFile(join(folder, 'dwfb.config.mjs'), "import './large.mjs';\n\nexport default { workflows: [] };\n");
      await assert.rejects(
        loadConfig(join(folder, 'dwfb.config.mjs')),
        isUsageError(new RegExp(`does not load\\. .+\\. The file ${displayFolder}/large\\.mjs is ${Buffer.byteLength(largeModuleText)} bytes, which is more than the ${READ_BYTE_LIMIT} bytes dwfb reads, so the place of the syntax error is unknown$`)),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('passes a CommonJS import larger than READ_BYTE_LIMIT that Node\'s error does not name, and names no such file', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));
    const largeCommonJsText = `module.exports = '${'a'.repeat(READ_BYTE_LIMIT)}';\n`;

    try {
      await mkdir(join(folder, 'sub'));
      await writeFile(join(folder, 'sub', 'package.json'), '{ "type": "commonjs" }\n');
      await writeFile(join(folder, 'large.cjs'), largeCommonJsText);
      await writeFile(join(folder, 'sub', 'large.js'), largeCommonJsText);
      await writeFile(join(folder, 'bad.mjs'), 'const = ;\n');
      await writeFile(join(folder, 'requires-bad.cjs'), "require('./bad.cjs');\n");
      await writeFile(join(folder, 'bad.cjs'), 'const = ;\n');
      await writeFile(join(folder, 'imports-module.mjs'), "import './large.cjs';\nimport './sub/large.js';\nimport './bad.mjs';\n\nexport default { workflows: [] };\n");
      await writeFile(join(folder, 'imports-required.mjs'), "import './large.cjs';\nimport './requires-bad.cjs';\n\nexport default { workflows: [] };\n");
      await assert.rejects(loadConfig(join(folder, 'imports-module.mjs')), isUsageError(new RegExp(`does not load\\. ${displayFolder}/bad\\.mjs:1:7 Unexpected token$`)));
      await assert.rejects(loadConfig(join(folder, 'imports-required.mjs')), isUsageError(/does not load\. Unexpected token '='$/));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names an ES module that does not parse ahead of an earlier CommonJS import, which Node compiles only as it runs it', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await mkdir(join(folder, 'sub'));
      await writeFile(join(folder, 'sub', 'package.json'), '{ "type": "commonjs" }\n');
      await writeFile(join(folder, 'sub', 'a.js'), 'module.exports = ;\n');
      await writeFile(join(folder, 'b.mjs'), 'export const b = );\n');
      await writeFile(join(folder, 'c.mjs'), 'export const c = 1;\n');
      await writeFile(join(folder, 'imports-bad.mjs'), "import './sub/a.js';\nimport './b.mjs';\n\nexport default { workflows: [] };\n");
      await writeFile(join(folder, 'imports-good.mjs'), "import './sub/a.js';\nimport './c.mjs';\n\nexport default { workflows: [] };\n");
      await assert.rejects(loadConfig(join(folder, 'imports-bad.mjs')), (error) => error.message.endsWith(`does not load. ${displayFolder}/b.mjs:1:18 Unexpected token`));
      await assert.rejects(loadConfig(join(folder, 'imports-good.mjs')), (error) => error.message.endsWith(`does not load. ${displayFolder}/sub/a.js:1:18 Unexpected token`));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('gives the cause an ES module throws as it runs ahead of a CommonJS import that does not parse, which Node never compiled', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));

    try {
      await writeFile(join(folder, 'b.mjs'), "JSON.parse('{');\n");
      await writeFile(join(folder, 'a.cjs'), 'module.exports = ;\n');
      await writeFile(join(folder, 'dwfb.config.mjs'), "import './b.mjs';\nimport './a.cjs';\n\nexport default { workflows: [] };\n");
      await assert.rejects(loadConfig(join(folder, 'dwfb.config.mjs')), isUsageError(/does not load\. [^:\n]* in JSON at position 1\b[^:\n]*$/));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('gives the cause of a thrown SyntaxError whose stack names no file or cannot be read as text', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const missingFile = JSON.stringify(join(folder, 'missing.cjs'));

    try {
      await writeFile(join(folder, 'a.cjs'), 'module.exports = ;\n');
      await writeFile(join(folder, 'missing-file.mjs'), `const error = new SyntaxError('stack names a missing file');\nerror.stack = ${missingFile} + ':1\\n';\nthrow error;\n`);
      await writeFile(join(folder, 'stack-not-text.mjs'), "const error = new SyntaxError('stack is no text');\nerror.stack = { toString() { throw 1; } };\nthrow error;\n");
      await writeFile(join(folder, 'stack-throws.mjs'), "const error = new SyntaxError('stack throws');\nObject.defineProperty(error, 'stack', { get() { throw 1; } });\nthrow error;\n");
      for (const [name, pattern] of [
        ['missing-file', /does not load\. stack names a missing file$/],
        ['stack-not-text', /does not load\. stack is no text$/],
        ['stack-throws', /does not load\. stack throws$/],
      ]) {
        await writeFile(join(folder, `${name}.config.mjs`), `import './${name}.mjs';\nimport './a.cjs';\n\nexport default { workflows: [] };\n`);
        await assert.rejects(loadConfig(join(folder, `${name}.config.mjs`)), isUsageError(pattern), name);
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names the place of module syntax in a CommonJS import of an ES config file, with the recovery its ending allows', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await mkdir(join(folder, 'sub'));
      await writeFile(join(folder, 'sub', 'package.json'), '{ "type": "commonjs" }\n');
      await writeFile(join(folder, 'sub', 'a.js'), 'export const x = 1;\n');
      await writeFile(join(folder, 'sub', 'b.cjs'), 'export const y = 1;\n');
      await writeFile(join(folder, 'dwfb.config.mjs'), "import './sub/a.js';\n\nexport default { workflows: [] };\n");
      await writeFile(join(folder, 'imports-cjs.mjs'), "import './sub/b.cjs';\n\nexport default { workflows: [] };\n");
      await assert.rejects(
        loadConfig(join(folder, 'dwfb.config.mjs')),
        (error) => error.message.endsWith(`does not load. ${displayFolder}/sub/a.js:1:1 'import' and 'export' may appear only with 'sourceType: module'. If the file is an ES module, set "type": "module" in the nearest package.json, or rename it to a .mjs file`),
      );
      await assert.rejects(
        loadConfig(join(folder, 'imports-cjs.mjs')),
        (error) => error.message.endsWith(`does not load. ${displayFolder}/sub/b.cjs:1:1 'import' and 'export' may appear only with 'sourceType: module'. If the file is an ES module, rename it to a .mjs file`),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('gives the cause a CommonJS config file with a top-level new.target throws as it runs', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));

    try {
      await writeFile(join(folder, 'package.json'), '{ "type": "commonjs" }\n');
      await writeFile(join(folder, 'dwfb.config.js'), "if (new.target) throw 1;\nmodule.exports = { workflows: JSON.parse('{') };\n");
      await assert.rejects(loadConfig(join(folder, 'dwfb.config.js')), isUsageError(/does not load\. [^:\n]* in JSON at position 1\b[^:\n]*$/));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('gives a .cjs config file that holds module syntax only the .mjs recovery, since no package.json "type" changes it', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));

    try {
      await writeFile(join(folder, 'config.cjs'), "import './a.js';\n\nmodule.exports = { workflows: [] };\n");
      await assert.rejects(
        loadConfig(join(folder, 'config.cjs')),
        isUsageError(/does not load\. Cannot use import statement outside a module\. If the file is an ES module, name a \.mjs config file with --config$/),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names an import of a package with no "type" whose only module syntax is nested, as Node reparses it as an ES module', { skip: !IS_MODULE_SYNTAX_DETECTED }, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await writeFile(join(folder, 'package.json'), '{ "private": true }\n');
      await writeFile(join(folder, 'nested.js'), 'if (true) {\n  export const q = 1;\n}\nvar z = ;\n');
      await writeFile(join(folder, 'bad.mjs'), 'export const b = );\n');
      await writeFile(join(folder, 'dwfb.config.mjs'), "import './nested.js';\nimport './bad.mjs';\n\nexport default { workflows: [] };\n");
      await assert.rejects(
        loadConfig(join(folder, 'dwfb.config.mjs')),
        (error) => error.message.endsWith(`does not load. ${displayFolder}/nested.js:2:3 'import' and 'export' may only appear at the top level`),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names the file that does not parse relative to the real path of a working directory reached through a link', async (context) => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));

    try {
      await mkdir(join(folder, 'real'));
      await writeFile(join(folder, 'real', 'dwfb.config.mjs'), "import './bad.mjs';\n\nexport default { workflows: [] };\n");
      await writeFile(join(folder, 'real', 'bad.mjs'), 'export const b = );\n');
      try {
        await symlink(join(folder, 'real'), join(folder, 'link'), 'junction');
      } catch (error) {
        if (error.code === 'EPERM') return context.skip('this account cannot create a link');
        throw error;
      }
      assert.equal(runLoadConfig(join(folder, 'link'), 'dwfb.config.mjs'), 'The config file dwfb.config.mjs does not load. bad.mjs:1:18 Unexpected token');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names each path of a load error relative to the real path of a working directory reached through a link', async (context) => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));

    try {
      await mkdir(join(folder, 'real'));
      await writeFile(join(folder, 'real', 'dwfb.config.mjs'), "import './missing.js';\n\nexport default { workflows: [] };\n");
      await writeFile(join(folder, 'real', 'throws.mjs'), "throw new Error('cannot read ' + process.cwd());\n");
      try {
        await symlink(join(folder, 'real'), join(folder, 'link'), 'junction');
      } catch (error) {
        if (error.code === 'EPERM') return context.skip('this account cannot create a link');
        throw error;
      }
      assert.equal(runLoadConfig(join(folder, 'link'), 'dwfb.config.mjs'), "The config file dwfb.config.mjs does not load. Cannot find module 'missing.js' imported from dwfb.config.mjs");
      assert.equal(runLoadConfig(join(folder, 'link'), 'throws.mjs'), 'The config file throws.mjs does not load. cannot read .');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names a path of a load error by its spelling when its real folder is on another drive than the working directory', async (context) => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const otherDriveFolder = fileURLToPath(new URL('./fixtures/', import.meta.url));

    try {
      if (parse(otherDriveFolder).root.toLowerCase() === parse(folder).root.toLowerCase()) {
        return context.skip('the fixtures sit on the drive of the temporary folder');
      }
      await symlink(otherDriveFolder, join(folder, 'other-drive'), 'junction');
      await writeFile(join(folder, 'dwfb.config.mjs'), "import './other-drive/absent.js';\n\nexport default { workflows: [] };\n");
      assert.equal(runLoadConfig(folder, 'dwfb.config.mjs'), "The config file dwfb.config.mjs does not load. Cannot find module 'other-drive/absent.js' imported from dwfb.config.mjs");
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names a path of a thrown message by its spelling when a folder of it is a link that loops', async (context) => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      try {
        await symlink(join(folder, 'loop'), join(folder, 'loop'), 'junction');
      } catch (error) {
        if (error.code === 'EPERM') return context.skip('this account cannot create a link');
        throw error;
      }
      await writeFile(join(folder, 'dwfb.config.mjs'), `throw new Error(${JSON.stringify(join(folder, 'loop', 'a.js'))});\n`);
      await assert.rejects(loadConfig(join(folder, 'dwfb.config.mjs')), (error) => error.name === 'UsageError' && error.message.endsWith(`does not load. ${displayFolder}/loop/a.js`));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names no absolute path and keeps a quoted slash in the message for an import with an encoded slash', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await writeFile(join(folder, 'dwfb.config.mjs'), "import './a%2Fb.js';\n\nexport default { workflows: [] };\n");
      await assert.rejects(
        loadConfig(join(folder, 'dwfb.config.mjs')),
        (error) => error.message.includes(`"${displayFolder}/a%2Fb.js" must not include encoded "/" or "\\" characters`),
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('finds the file that does not parse before an import that names no file path', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await writeFile(join(folder, 'bad.mjs'), 'export const x = ;\n');
      for (const [index, specifier] of ['./a%2Fb.js', './100%.js', './a%00.js'].entries()) {
        const configFile = join(folder, `dwfb.config.${index}.mjs`);
        await writeFile(configFile, `import './bad.mjs';\nimport '${specifier}';\n\nexport default { workflows: [] };\n`);
        await assert.rejects(loadConfig(configFile), (error) => error.name === 'UsageError' && error.message.endsWith(`does not load. ${displayFolder}/bad.mjs:1:18 Unexpected token`), specifier);
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names the package.json of a CommonJS config file in a "type": "module" package by its relative path', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
      await writeFile(join(folder, 'dwfb.config.js'), 'module.exports = { workflows: [] };\n');
      await assert.rejects(loadConfig(join(folder, 'dwfb.config.js')), (error) => {
        assert.ok(error.message.includes(`module is not defined in ES module scope\nThis file is being treated as an ES module because it has a '.js' file extension and '${displayFolder}/package.json' contains`), error.message);
        assert.ok(!error.message.includes('\\\\?\\'), error.message);
        return true;
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names the working directory as . in a thrown message, and keeps text that is no path on disk', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));

    try {
      await writeFile(join(folder, 'dwfb.config.mjs'), "throw new Error('cannot read ' + process.cwd() + ' or /(/');\n");
      await assert.rejects(loadConfig(join(folder, 'dwfb.config.mjs')), isUsageError(/does not load\. cannot read \. or \/\(\/$/));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('names the file that does not parse for a config file of a package with no "type", which Node loads as an ES module', { skip: !IS_MODULE_SYNTAX_DETECTED }, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'dwfb-config-'));
    const displayFolder = formatForwardSlashes(relative(process.cwd(), folder));

    try {
      await mkdir(join(folder, 'rows'));
      await writeFile(join(folder, 'package.json'), '{ "private": true }\n');
      await writeFile(join(folder, 'dwfb.config.js'), "import { workflows } from './workflows.js';\n\nexport default { workflows };\n");
      await writeFile(join(folder, 'workflows.js'), "import { review } from './rows/review.js';\n\nexport const workflows = [review];\n");
      await writeFile(join(folder, 'rows', 'review.js'), "export const review = { entry: 'review.js', out: ; };\n");
      await assert.rejects(loadConfig(join(folder, 'dwfb.config.js')), (error) => error.message.endsWith(`does not load. ${displayFolder}/rows/review.js:1:50 Unexpected token`));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('rejects a missing file, a folder, a path that names a folder and a path that is not a string', async () => {
    const configFile = join(CONFIG_FIXTURES, 'project', 'dwfb.config.js');

    await assert.rejects(loadConfig(join(CONFIG_FIXTURES, 'none.config.js')), isUsageError(/^The config file .*none\.config\.js does not exist$/));
    await assert.rejects(loadConfig(CONFIG_FIXTURES), isUsageError(/is not a file$/));
    for (const path of [`${configFile}/`, `${configFile}/.`]) await assert.rejects(loadConfig(path), isUsageError(/^The config file .*dwfb\.config\.js\/\.? is not a file$/));
    for (const path of [undefined, '', 1]) await assert.rejects(loadConfig(path), isUsageError(/^loadConfig\(\) needs path, the path of a config file$/));
  });
});
