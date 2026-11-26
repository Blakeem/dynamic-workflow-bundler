import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';
import { build, locate } from 'dynamic-workflow-bundler';
import { formatCommandPath } from '../src/build-command.js';
import { READ_BYTE_LIMIT } from '../src/read-byte-limit.js';
import { writeSizedFile } from './support/write-sized-file.js';

const ENTRY_TEXT = [
  'export const meta = {',
  "  name: 'locate-fixture',",
  "  description: 'Holds every kind of source',",
  '};',
  "import { greet } from './greet.js';",
  "import { shout } from './shout.js';",
  "import notes from './notes.md';",
  '// @include ./part.js',
  'return [greet(notes), shout(partValue)];',
  '',
].join('\n');
const FIXTURE_FILES = Object.freeze({
  'entry.js': ENTRY_TEXT,
  'greet.js': 'export function greet(name) {\n  return `Hello ${name}`;\n}\n',
  'shout.js': 'export const shout = (text) => text.toUpperCase();\n',
  'notes.md': 'first `line`\nsecond line\n',
  'part.js': 'const partValue = 2;\n',
});

const temporaryFolders = [];
after(async () => {
  for (const folder of temporaryFolders) await rm(folder, { recursive: true, force: true });
});

/**
 * Writes the fixture into a new folder and builds it.
 * @param {boolean} [banner]
 * @returns {Promise<{ folder: string, entry: string, script: string, lines: string[] }>} The real path of the
 *   folder, and the built script's lines.
 */
async function writeBuiltFixture(banner = true) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'dwfb-locate-')));
  temporaryFolders.push(folder);
  for (const [name, text] of Object.entries(FIXTURE_FILES)) await writeFile(join(folder, name), text);
  const entry = join(folder, 'entry.js');
  const script = join(folder, 'dist', 'workflow.js');
  await build({ entry, out: script, banner });
  const lines = (await readFile(script, 'utf8')).split('\n');
  return { folder, entry, script, lines };
}

/**
 * @param {string} folder
 * @param {string} name
 * @returns {string} The path as a build reports it.
 */
function formatPath(folder, name) {
  return relative(process.cwd(), join(folder, name)).split('\\').join('/');
}

describe('locate', () => {
  it('maps one line of the entry, of each module, of the text file and of the part to its source line', async () => {
    const { folder, script, lines } = await writeBuiltFixture();
    const cases = [
      { builtText: 'return [greet(notes), shout(partValue)];', file: 'entry.js', line: 9, column: 1 },
      { builtText: '  return `Hello ${name}`;', file: 'greet.js', line: 2, column: 1 },
      { builtText: 'const shout = (text) => text.toUpperCase();', file: 'shout.js', line: 1, column: 8 },
      { builtText: 'first \\`line\\`', file: 'notes.md', line: 1, column: 1 },
      { builtText: 'const partValue = 2;', file: 'part.js', line: 1, column: 1 },
    ];

    for (const { builtText, file, line, column } of cases) {
      const builtLine = lines.indexOf(builtText) + 1;
      const text = FIXTURE_FILES[file].split('\n')[line - 1];
      assert.ok(builtLine > 0, builtText);
      assert.deepEqual(await locate({ script, line: builtLine }), { ok: true, file: formatPath(folder, file), line, column, text, generated: false, findings: [] }, file);
    }
  });

  it('maps a column past the text that the build removes from a line', async () => {
    const { script, lines } = await writeBuiltFixture();
    const builtLine = lines.indexOf('const shout = (text) => text.toUpperCase();') + 1;

    const result = await locate({ script, line: builtLine, column: 15 });

    assert.equal(result.column, 22);
    assert.equal(result.text.slice(result.column - 1), '(text) => text.toUpperCase();');
  });

  it('reads runtime line 3 as script line 6 when the meta statement ends on line 4 and the banner is line 5', async () => {
    const { script, lines } = await writeBuiltFixture();

    assert.equal(lines[3], '};');
    assert.match(lines[4], /^\/\/ Built by dynamic-workflow-bundler from \.\.\/entry\.js\./);
    assert.deepEqual(await locate({ script, line: 3, column: 2, runtime: true }), await locate({ script, line: 6, column: 2 }));
    assert.deepEqual(await locate({ script, line: 2, runtime: true }), await locate({ script, line: 5 }));
  });

  it('gives generated for a line the build adds, with the source whose scope holds it', async () => {
    const { folder, script, lines } = await writeBuiltFixture();
    const scopeLine = lines.findIndex((line) => line.startsWith('const __dwfb_greet_js_')) + 1;

    assert.deepEqual(await locate({ script, line: 5 }), { ok: true, file: null, line: null, column: null, text: null, generated: true, findings: [] });
    assert.deepEqual(await locate({ script, line: scopeLine }), { ok: true, file: formatPath(folder, 'greet.js'), line: null, column: null, text: null, generated: true, findings: [] });
  });

  it('finds script-stale for a source edited after the build, and the findings of a source that has one', async () => {
    const { folder, script, lines } = await writeBuiltFixture();
    const greetLine = lines.indexOf('  return `Hello ${name}`;') + 1;

    await writeFile(join(folder, 'greet.js'), 'export function greet(name) {\n  return `Hi ${name}`;\n}\n');
    const stale = await locate({ script, line: 1 });
    await writeFile(join(folder, 'greet.js'), 'export let greet = 1;\n');
    const failed = await locate({ script, line: 1 });

    assert.deepEqual(stale, {
      ok: false,
      file: null,
      line: null,
      column: null,
      text: null,
      generated: false,
      findings: [{
        rule: 'script-stale',
        message: 'The script differs from the script the build gives',
        fix: `Run dwfb build ${formatCommandPath(join(folder, 'entry.js'))} --out ${formatCommandPath(script)}, since the line numbers may not match the source`,
        file: formatPath(folder, 'dist/workflow.js'),
        line: greetLine,
        column: 1,
      }],
    });
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.findings.map(({ rule, file }) => ({ rule, file })), [{ rule: 'export-not-constant', file: formatPath(folder, 'greet.js') }]);
  });

  it('names a script that is a file link by its own name in the script-stale finding, as dwfb build names its out', async (context) => {
    const { folder, script } = await writeBuiltFixture();
    const linkScript = join(folder, 'dist', 'link.js');
    try {
      await symlink(script, linkScript, 'file');
    } catch (error) {
      // Windows refuses a file link to a user without the privilege to create one.
      if (error.code === 'EPERM') return context.skip('this user cannot create a file link');
      throw error;
    }
    await writeFile(join(folder, 'greet.js'), 'export function greet(name) {\n  return `Hi ${name}`;\n}\n');

    const [finding] = (await locate({ script: linkScript, line: 1 })).findings;

    assert.deepEqual({ rule: finding.rule, file: finding.file }, { rule: 'script-stale', file: formatPath(folder, 'dist/link.js') });
  });

  it('finds the entry of a script with no banner from the config file\'s workflow whose out is the script', async () => {
    const { folder, script, lines } = await writeBuiltFixture(false);
    const config = join(folder, 'dwfb.config.mjs');
    const otherConfig = join(folder, 'other.config.mjs');
    await writeFile(config, "export default { workflows: [{ entry: 'part.js', out: 'dist/part.js' }, { entry: 'entry.js', out: 'dist/workflow.js', banner: false }] };\n");
    await writeFile(otherConfig, "export default { workflows: [{ entry: 'entry.js', out: 'dist/other.js' }] };\n");

    const result = await locate({ script, line: lines.indexOf('const partValue = 2;') + 1, config });

    assert.deepEqual({ file: result.file, line: result.line }, { file: formatPath(folder, 'part.js'), line: 1 });
    await assert.rejects(locate({ script, line: 1, config: otherConfig }), { name: 'UsageError', message: /has no banner, and the config file .* has no workflow whose out is the script, so name the entry it is built from with --entry <file>$/ });
    await assert.rejects(locate({ script, line: 1 }), { name: 'UsageError', message: /has no banner, and no config file dwfb\.config\.js or dwfb\.config\.mjs exists here/ });
  });

  it('reads dwfb.config.mjs from the working directory, refuses it beside dwfb.config.js, and needs neither for a script with a banner', async () => {
    const { folder, entry, script, lines } = await writeBuiltFixture(false);
    const bannerScript = join(folder, 'dist', 'banner.js');
    const partLine = lines.indexOf('const partValue = 2;') + 1;
    const configText = "export default { workflows: [{ entry: 'entry.js', out: 'dist/workflow.js', banner: false }] };\n";
    const workFolder = process.cwd();
    await build({ entry, out: bannerScript });
    const bannerPartLine = (await readFile(bannerScript, 'utf8')).split('\n').indexOf('const partValue = 2;') + 1;
    // A CommonJS package loads only the .mjs config file as an ES module.
    await writeFile(join(folder, 'package.json'), '{ "type": "commonjs" }\n');
    await writeFile(join(folder, 'dwfb.config.mjs'), configText);

    process.chdir(folder);
    try {
      const fromModuleConfig = await locate({ script, line: partLine });
      await writeFile(join(folder, 'dwfb.config.js'), configText);
      await assert.rejects(locate({ script, line: partLine }), {
        name: 'UsageError',
        message: 'The config files dwfb.config.js and dwfb.config.mjs both exist here, so remove one or name one with --config <path>',
      });
      const fromBanner = await locate({ script: bannerScript, line: bannerPartLine });
      const fromNamedConfig = await locate({ script, line: partLine, config: 'dwfb.config.mjs' });

      assert.deepEqual({ file: fromModuleConfig.file, line: fromModuleConfig.line }, { file: 'part.js', line: 1 });
      assert.deepEqual({ file: fromBanner.file, line: fromBanner.line }, { file: 'part.js', line: 1 });
      assert.deepEqual({ file: fromNamedConfig.file, line: fromNamedConfig.line }, { file: 'part.js', line: 1 });
    } finally {
      process.chdir(workFolder);
    }
  });

  it('names --no-banner in the script-stale fix of a script with no banner', async () => {
    const { folder, script } = await writeBuiltFixture(false);
    const config = join(folder, 'dwfb.config.mjs');
    await writeFile(config, "export default { workflows: [{ entry: 'entry.js', out: 'dist/workflow.js', banner: false }] };\n");
    await writeFile(join(folder, 'part.js'), 'const partValue = 3;\n');

    const [finding] = (await locate({ script, line: 1, config })).findings;

    assert.equal(finding.fix, `Run dwfb build ${formatCommandPath(join(folder, 'entry.js'))} --out ${formatCommandPath(script)} --no-banner, since the line numbers may not match the source`);
  });

  it('names the banner of the config file\'s workflow in the script-stale fix of a script that does not parse or has no banner', async () => {
    const { folder, script, lines } = await writeBuiltFixture(false);
    const noBannerConfig = join(folder, 'no-banner.config.mjs');
    const bannerConfig = join(folder, 'banner.config.mjs');
    const buildCommand = `dwfb build ${formatCommandPath(join(folder, 'entry.js'))} --out ${formatCommandPath(script)}`;
    await writeFile(noBannerConfig, "export default { workflows: [{ entry: 'entry.js', out: 'dist/workflow.js', banner: false }] };\n");
    await writeFile(bannerConfig, "export default { workflows: [{ entry: 'entry.js', out: 'dist/workflow.js' }] };\n");

    assert.equal((await locate({ script, line: 1, config: bannerConfig })).ok, true);
    await writeFile(join(folder, 'part.js'), 'const partValue = 3;\n');
    const [bannerFinding] = (await locate({ script, line: 1, config: bannerConfig })).findings;
    await writeFile(script, ['<<<<<<< HEAD', ...lines].join('\n'));
    const [noBannerFinding] = (await locate({ script, line: 1, config: noBannerConfig })).findings;

    assert.equal(bannerFinding.fix, `Run ${buildCommand}, since the line numbers may not match the source`);
    assert.deepEqual({ rule: noBannerFinding.rule, fix: noBannerFinding.fix }, { rule: 'script-stale', fix: `Run ${buildCommand} --no-banner, since the line numbers may not match the source` });
  });

  it('names the banner and asks for the entry when the entry the banner names does not exist', async () => {
    const { folder, script } = await writeBuiltFixture();
    await rename(join(folder, 'entry.js'), join(folder, 'moved.js'));

    await assert.rejects(locate({ script, line: 1 }), {
      name: 'UsageError',
      message: /^The banner of the script .*workflow\.js names the entry .*entry\.js, which does not exist, so name the entry it is built from with --entry <file>$/,
    });
  });

  it('names the banner and asks for the entry when the entry the banner names is a link that loops', async (context) => {
    const { folder, script, lines } = await writeBuiltFixture();
    try {
      await symlink('loop-back.js', join(folder, 'loop.js'), 'file');
      await symlink('loop.js', join(folder, 'loop-back.js'), 'file');
    } catch (error) {
      if (error.code === 'EPERM') return context.skip('this account cannot create a symbolic link');
      throw error;
    }
    await writeFile(script, lines.with(4, lines[4].replace('../entry.js', '../loop.js')).join('\n'));

    await assert.rejects(locate({ script, line: 1 }), { name: 'UsageError', message: /^The banner of the script .*workflow\.js names the entry .*loop\.js, which is a link that loops, so name the entry/ });
  });

  it('names the banner and asks for the entry when the entry the banner names is a folder', async () => {
    const { folder, script, lines } = await writeBuiltFixture();
    await mkdir(join(folder, 'sub'));
    await writeFile(script, lines.with(4, lines[4].replace('../entry.js', '../sub')).join('\n'));

    await assert.rejects(locate({ script, line: 1 }), {
      name: 'UsageError',
      message: /^The banner of the script .*workflow\.js names the entry .*sub, which is not a file, so name the entry it is built from with --entry <file>$/,
    });
  });

  it('names the banner and asks for the entry when the banner names the script itself', async () => {
    const { script, lines } = await writeBuiltFixture();
    await writeFile(script, lines.with(4, lines[4].replace('../entry.js', 'workflow.js')).join('\n'));

    await assert.rejects(locate({ script, line: 1 }), {
      name: 'UsageError',
      message: /^The banner of the script .*workflow\.js names the script itself as its entry, so name the entry it is built from with --entry <file>$/,
    });
  });

  it('asks for the entry when the banner names a path with a root of the platform, even one that names the entry', async () => {
    const { entry, script, lines } = await writeBuiltFixture();
    const windowsRootedPaths = ['C:/entry.js', 'C:entry.js', '\\entry.js'];
    const isWindows = process.platform === 'win32';
    const rootedPaths = [entry.split('\\').join('/'), '/entry.js', ...(isWindows ? windowsRootedPaths : [])];
    const posixRelativePaths = isWindows ? [] : windowsRootedPaths;

    for (const rootedPath of rootedPaths) {
      await writeFile(script, lines.with(4, lines[4].replace('../entry.js', rootedPath)).join('\n'));

      await assert.rejects(locate({ script, line: 1 }), {
        name: 'UsageError',
        message: /^The banner of the script .*workflow\.js names no relative path, so name the entry it is built from with --entry <file>$/,
      }, rootedPath);
    }
    for (const relativePath of posixRelativePaths) {
      await writeFile(script, lines.with(4, lines[4].replace('../entry.js', relativePath)).join('\n'));

      await assert.rejects(locate({ script, line: 1 }), { name: 'UsageError', message: /, which does not exist, so name the entry/ }, relativePath);
    }
  });

  it('says that a script does not parse in place of that it has no banner, and finds script-stale for it with the entry option', async () => {
    const { entry, script, lines } = await writeBuiltFixture();
    await writeFile(script, ['export const meta = {;', ...lines.slice(1)].join('\n'));

    await assert.rejects(locate({ script, line: 1 }), { name: 'UsageError', message: /^The script .*workflow\.js does not parse, and no config file dwfb\.config\.js or dwfb\.config\.mjs exists here, so name the entry it is built from with --entry <file>$/ });
    const [finding] = (await locate({ script, line: 1, entry })).findings;

    assert.deepEqual({ rule: finding.rule, line: finding.line, fix: finding.fix }, {
      rule: 'script-stale',
      line: 1,
      fix: `Run dwfb build ${formatCommandPath(entry)} --out ${formatCommandPath(script)}, since the line numbers may not match the source`,
    });
  });

  it('builds from the entry option in place of the banner', async () => {
    const { folder, entry, script } = await writeBuiltFixture();
    await mkdir(join(folder, 'copy'));
    for (const [name, text] of Object.entries(FIXTURE_FILES)) await writeFile(join(folder, 'copy', name), text);

    assert.equal((await locate({ script, line: 1, entry })).ok, true);
    assert.equal((await locate({ script, line: 1, entry: join(folder, 'copy', 'entry.js') })).findings[0].rule, 'script-stale');
  });

  it('rejects a missing script, a folder, a line or column that is not a whole number of 1 or more or lies past the script, and options of another shape', async () => {
    const { folder, script, lines } = await writeBuiltFixture();
    const lastLine = lines.length - 1;
    const rejections = [
      [{ script: join(folder, 'missing.js'), line: 1 }, /The script file .*missing\.js does not exist/],
      [{ script: folder, line: 1 }, /is not a file/],
      [{ script: `${script}/`, line: 1 }, /^The script .*\/ is not a file$/],
      [{ script: `${script}/.`, line: 1 }, /^The script .*\/\. is not a file$/],
      [{ script, line: 0 }, /The line 0 is not a whole number of 1 or more/],
      [{ script, line: 1.5 }, /The line 1\.5 is not a whole number of 1 or more/],
      [{ script, line: '1' }, /locate\(\) needs line as a number/],
      [{ script, line: 1, column: 0 }, /The column 0 is not a whole number of 1 or more/],
      [{ script, line: lastLine + 1 }, new RegExp(`ends on line ${lastLine}, so line ${lastLine + 1} is past its end`)],
      [{ script, line: lastLine + 1, runtime: true }, new RegExp(`ends on line ${lastLine}, so the runtime line ${lastLine + 1}, which is line ${lastLine + 4}, is past its end`)],
      [{ script, line: 1, runtime: true }, /The runtime line 1 holds no line of the script/],
      [{ script, line: 1, column: lines[0].length + 2 }, new RegExp(`Column ${lines[0].length + 2} is past the end of line 1 of the script .*, which ends at column ${lines[0].length + 1}$`)],
      [
        { script, line: 3, column: lines[5].length + 2, runtime: true },
        new RegExp(`^The runtime column ${lines[5].length + 2}, which is column ${lines[5].length + 2}, is past the end of the runtime line 3, which is line 6, of the script .*, which ends at column ${lines[5].length + 1}$`),
      ],
      [{ script, line: 1, runtime: 'yes' }, /locate\(\) takes runtime as a boolean/],
      [{ script, line: 1, entry: '' }, /locate\(\) takes entry as the path of an entry file/],
      [{ script, line: 1, Entry: 'x.js' }, /locate\(\) takes no option Entry/],
      [{ line: 1 }, /locate\(\) needs script/],
      [null, /locate\(\) takes an options object/],
    ];

    for (const [options, message] of rejections) await assert.rejects(locate(options), { name: 'UsageError', message }, JSON.stringify(options));
    assert.equal((await locate({ script, line: 1, column: lines[0].length + 1 })).column, lines[0].length + 1);
    assert.equal((await locate({ script, line: lastLine })).ok, true);
  });

  it('reads a script of READ_BYTE_LIMIT bytes, and rejects a script one byte larger', async () => {
    const { folder, entry } = await writeBuiltFixture();
    const limitScript = join(folder, 'limit.js');
    const largeScript = join(folder, 'large.js');
    await writeSizedFile(limitScript, READ_BYTE_LIMIT);
    await writeSizedFile(largeScript, READ_BYTE_LIMIT + 1);

    // A script that differs from its build gives script-stale only once locate read it.
    assert.deepEqual((await locate({ script: limitScript, line: 1, entry })).findings.map((finding) => finding.rule), ['script-stale']);
    await assert.rejects(locate({ script: largeScript, line: 1, entry }), {
      name: 'UsageError',
      message: `The script ${largeScript} is ${READ_BYTE_LIMIT + 1} bytes, which is more than the ${READ_BYTE_LIMIT} bytes dwfb reads`,
    });
  });
});
