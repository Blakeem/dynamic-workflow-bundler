import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from 'dynamic-workflow-bundler';
import { formatForwardSlashes } from '../src/display-path.js';
import { IS_MODULE_SYNTAX_DETECTED } from '../src/load-config.js';

const CONFIG_FIXTURES = fileURLToPath(new URL('./fixtures/config/', import.meta.url));

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
  'workflow-not-object': /^Workflow 2 of the config file .* is not an object of the form \{ entry, out, banner \}$/,
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
        { entry: join(folder, 'workflows', 'review', 'entry.js'), out: join(folder, 'dist', 'review.js'), banner: true },
        { entry: join(folder, 'workflows', 'summary', 'entry.js'), out: join(folder, 'dist', 'summary.js'), banner: false },
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
      await writeFile(join(folder, 'broken.js'), 'export default { workflows: [ };\n');
      await writeFile(join(folder, 'imports.js'), "import './bad.js';\n\nexport default { workflows: [] };\n");
      await writeFile(join(folder, 'bad.js'), 'export const x = ;\n');
      await assert.rejects(loadConfig(join(folder, 'broken.js')), (error) => error.message.endsWith(`does not load. ${displayFolder}/broken.js:1:31 Unexpected token`));
      await assert.rejects(loadConfig(join(folder, 'imports.js')), isUsageError(/does not load\. Cannot use import statement outside a module\. If the file is an ES module, set "type": "module"/));
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
