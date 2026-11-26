import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const COMMAND = fileURLToPath(new URL('../bin/dwfb.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const MODULES_ENTRY = join(FIXTURES, 'modules', 'entry.js');
const CONFIG_FIXTURES = join(FIXTURES, 'config');
const PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const temporaryFolders = [];
after(async () => {
  for (const folder of temporaryFolders) await rm(folder, { recursive: true, force: true });
});

/** @returns {Promise<string>} */
async function makeTemporaryFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'dwfb-command-'));
  temporaryFolders.push(folder);
  return folder;
}

/**
 * Copies the modules fixture into a temporary folder, so that a built script sits on the drive of its entry.
 * @returns {Promise<string>} The temporary folder, which holds the fixture as `modules`.
 */
async function copyModulesFixture() {
  const folder = await makeTemporaryFolder();
  await cp(join(FIXTURES, 'modules'), join(folder, 'modules'), { recursive: true });
  return folder;
}

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
function runCommand(args, cwd = process.cwd()) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [COMMAND, ...args], { cwd, encoding: 'utf8' });
  return { status, stdout, stderr };
}

describe('dwfb', () => {
  it('prints the package version', () => {
    assert.deepEqual(runCommand(['--version']), { status: 0, stdout: `${PACKAGE.version}\n`, stderr: '' });
  });

  it('prints usage for --help and build --help', () => {
    const main = runCommand(['--help']);
    const buildHelp = runCommand(['build', '--help']);

    assert.equal(main.status, 0);
    assert.match(main.stdout, /^Usage: dwfb <command>/);
    assert.equal(buildHelp.status, 0);
    assert.match(buildHelp.stdout, /^Usage: dwfb build \[<entry>\] \[--out <file>\]/);
    assert.match(buildHelp.stdout, /--config <path> {3}Read this config file in place of dwfb\.config\.js or dwfb\.config\.mjs\./);
  });

  it('prints usage to stderr and exits 2 with no command, an unknown command or an unknown option', () => {
    for (const args of [[], ['bundle'], ['--verbose'], ['build', MODULES_ENTRY, '--out', 'x.js', '--watch']]) {
      const { status, stdout, stderr } = runCommand(args);
      assert.equal(status, 2, args.join(' '));
      assert.equal(stdout, '');
      assert.match(stderr, /Usage: dwfb/);
    }
  });

  it('names the extra argument after --help or --version', () => {
    for (const args of [['--help', 'build'], ['--version', '']]) {
      const { status, stdout, stderr } = runCommand(args);
      assert.equal(status, 2, args.join(' '));
      assert.equal(stdout, '');
      assert.ok(stderr.startsWith(`dwfb: The option ${args[0]} takes no other argument, and ${JSON.stringify(args[1])} follows it.\n`), stderr);
    }
  });
});

describe('dwfb build', () => {
  it('writes the script and prints its path, source count and size', async () => {
    const folder = await copyModulesFixture();

    const { status, stdout } = runCommand(['build', 'modules/entry.js', '--out', 'dist/workflow.js'], folder);
    const script = await readFile(join(folder, 'dist', 'workflow.js'), 'utf8');

    assert.equal(status, 0);
    assert.equal(stdout, `Built dist/workflow.js from 7 source files, ${Buffer.byteLength(script)} bytes.\n`);
  });

  it('writes the same bytes from two working directories', async () => {
    const folder = await copyModulesFixture();
    const out = join(folder, 'workflow.js');

    runCommand(['build', join('modules', 'entry.js'), '--out', out], folder);
    const first = await readFile(out);
    runCommand(['build', 'entry.js', '--out', out], join(folder, 'modules'));
    const second = await readFile(out);

    assert.ok(first.length > 0);
    assert.ok(first.equals(second));
  });

  it('writes the same bytes and paths from a folder reached through a link', async () => {
    const folder = await makeTemporaryFolder();
    const realFolder = join(folder, 'real');
    const linkFolder = join(folder, 'link');
    await mkdir(realFolder);
    await writeFile(join(realFolder, 'entry.js'), "export const meta = {};\nimport { a } from './a.js';\nreturn a;\n");
    await writeFile(join(realFolder, 'a.js'), 'export const a = 1;\n');
    await symlink(realFolder, linkFolder, 'junction');

    const throughLink = runCommand(['build', 'entry.js', '--out', 'out.js', '--json'], linkFolder);
    const first = await readFile(join(realFolder, 'out.js'));
    const direct = runCommand(['build', 'entry.js', '--out', 'out.js', '--json'], realFolder);
    const second = await readFile(join(realFolder, 'out.js'));

    assert.deepEqual(JSON.parse(throughLink.stdout).workflows[0].sources, ['entry.js', 'a.js']);
    assert.equal(throughLink.stdout, direct.stdout);
    assert.match(first.toString('utf8'), /from entry\.js\./);
    assert.ok(first.equals(second));
  });

  it('names the entry, out and sources against one base from a folder reached through a link', async () => {
    const folder = await makeTemporaryFolder();
    const realFolder = join(folder, 'real');
    const linkFolder = join(folder, 'link');
    await mkdir(realFolder);
    await writeFile(join(realFolder, 'entry.js'), "export const meta = {};\nimport { a } from './a.js';\nreturn a;\n");
    await writeFile(join(realFolder, 'a.js'), 'export const a = 1;\n');
    await symlink(realFolder, linkFolder, 'junction');

    const written = runCommand(['build', join(realFolder, 'entry.js'), '--out', join(realFolder, 'dist', 'out.js'), '--json'], linkFolder);
    const writtenText = runCommand(['build', join(realFolder, 'entry.js'), '--out', join(realFolder, 'dist', 'out.js')], linkFolder);
    // On POSIX the working directory's name is its real path, so only a link below it tells the two bases apart.
    const belowLink = runCommand(['build', join('link', 'entry.js'), '--out', join('link', 'dist', 'below.js'), '--json'], folder);
    const { entry, out, sources } = JSON.parse(written.stdout).workflows[0];
    const below = JSON.parse(belowLink.stdout).workflows[0];

    assert.equal(written.status, 0);
    assert.deepEqual({ entry, out, sources }, { entry: 'entry.js', out: 'dist/out.js', sources: ['entry.js', 'a.js'] });
    assert.match(writtenText.stdout, /^Built dist\/out\.js from 2 source files/);
    assert.equal(belowLink.status, 0);
    assert.deepEqual(
      { entry: below.entry, out: below.out, sources: below.sources },
      { entry: 'real/entry.js', out: 'real/dist/below.js', sources: ['real/entry.js', 'real/a.js'] },
    );
  });

  it('leaves out the banner with --no-banner', async () => {
    const folder = await makeTemporaryFolder();
    const out = join(folder, 'workflow.js');

    runCommand(['build', MODULES_ENTRY, '--out', out, '--no-banner']);

    assert.doesNotMatch(await readFile(out, 'utf8'), /Built by dynamic-workflow-bundler/);
  });

  it('prints one JSON object with --json, with paths relative to the working directory', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport { a } from './a.js';\nreturn a;\n");
    await writeFile(join(folder, 'a.js'), 'export const a = 1;\n');

    const written = runCommand(['build', 'entry.js', '--out', 'dist/out.js', '--json'], folder);
    const script = await readFile(join(folder, 'dist', 'out.js'), 'utf8');

    assert.equal(written.status, 0);
    assert.deepEqual(JSON.parse(written.stdout), {
      ok: true,
      workflows: [{ entry: 'entry.js', out: 'dist/out.js', status: 'written', bytes: Buffer.byteLength(script), sources: ['entry.js', 'a.js'], findings: [] }],
    });

    await writeFile(join(folder, 'a.js'), 'export let a = 1;\n');
    const failed = runCommand(['build', 'entry.js', '--out', 'dist/out.js', '--json'], folder);

    assert.equal(failed.status, 1);
    assert.deepEqual(JSON.parse(failed.stdout), {
      ok: false,
      workflows: [
        {
          entry: 'entry.js',
          out: 'dist/out.js',
          status: 'failed',
          bytes: null,
          sources: ['entry.js', 'a.js'],
          findings: [
            {
              rule: 'export-not-constant',
              message: 'The module exports a let binding',
              fix: 'Export a const, and keep state that changes in an exported object or function',
              file: 'a.js',
              line: 1,
              column: 1,
            },
          ],
        },
      ],
    });
    assert.equal(await readFile(join(folder, 'dist', 'out.js'), 'utf8'), script);
  });

  it('prints each finding in the finding format and exits 1', async () => {
    const folder = join(FIXTURES, 'rules', 'import-not-relative');

    const { status, stdout } = runCommand(['build', 'entry.js', '--out', 'out.js'], folder);

    assert.equal(status, 1);
    assert.equal(
      stdout,
      'entry.js:2:20 import-not-relative The specifier "helper-package" does not start with ./ or ../. Import a source file by a path that starts with ./ or ../.\n',
    );
  });

  it('exits 2 for a missing entry, no --out and no config file, two entries, an empty entry, --out or --config, and an --out that is a source', () => {
    const cases = [
      { args: ['build', 'missing.js', '--out', 'out.js'], message: /does not exist/ },
      { args: ['build', 'entry.js'], message: /^dwfb build: No config file dwfb\.config\.js or dwfb\.config\.mjs exists here, so name the built script with --out <file>\.\n$/ },
      { args: ['build'], message: /^dwfb build: No config file dwfb\.config\.js or dwfb\.config\.mjs exists here, so name an entry file\.\n$/ },
      { args: ['build', '--check'], message: /No config file dwfb\.config\.js or dwfb\.config\.mjs exists here/ },
      { args: ['build', 'entry.js', 'other.js', '--out', 'out.js'], message: /Name one entry file/ },
      { args: ['build', '', '--out', 'out.js'], message: /Name one entry file/ },
      { args: ['build', 'entry.js', '--out', ''], message: /Name the built script with --out <file>/ },
      { args: ['build', '--config', ''], message: /^dwfb build: Name the config file with --config <path>\.\n\nUsage: dwfb build/ },
      { args: ['build', '--out', 'out.js'], message: /Name the entry file that --out builds/ },
      { args: ['build', 'entry.js', '--out', 'out.js', '--config', 'dwfb.config.js'], message: /Name --out or --config, not both/ },
      { args: ['build', 'entry.js', '--out', 'lib/counter.js'], message: /is a source/ },
    ];

    for (const { args, message } of cases) {
      const { status, stdout, stderr } = runCommand(args, join(FIXTURES, 'modules'));
      assert.equal(status, 2, args.join(' '));
      assert.equal(stdout, '');
      assert.match(stderr, message);
    }
  });

  it('names the command that rewrites a missing or differing script, with the paths and --no-banner of the check', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\nreturn 1;\n');

    const missing = runCommand(['build', 'entry.js', '--out', 'my out.js', '--check', '--json'], folder);
    const missingText = runCommand(['build', join(folder, 'entry.js'), '--out', 'my out.js', '--check'], folder);
    const missingParenthesis = runCommand(['build', 'entry.js', '--out', 'out(1).js', '--check'], folder);
    runCommand(['build', 'entry.js', '--out', 'my out.js'], folder);
    const stale = runCommand(['build', 'entry.js', '--out', 'my out.js', '--no-banner', '--check'], folder);

    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).workflows[0].status, 'missing');
    assert.deepEqual(missingText, { status: 1, stdout: 'my out.js does not exist. Run dwfb build entry.js --out "my out.js".\n', stderr: '' });
    assert.equal(missingParenthesis.stdout, 'out(1).js does not exist. Run dwfb build entry.js --out "out(1).js".\n');
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /^my out\.js:2 differs from the script the build gives\. .* Run dwfb build entry\.js --out "my out\.js" --no-banner\.\n$/);
  });

  it('names the file and the cause of a file system failure, exits 2 and prints no stack', async (context) => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = {};\nimport './a.js';\n");
    await writeFile(join(folder, 'a.js'), '');
    await writeFile(join(folder, 'out.js'), '');
    // Windows refuses a rename over a read-only file, and POSIX refuses to open a file with no read permission.
    const failingFile = process.platform === 'win32' ? 'out.js' : 'a.js';
    const expected = process.platform === 'win32' ? '(rename EPERM)' : '(open EACCES)';
    if (process.getuid?.() === 0) return context.skip('root reads every file');
    await chmod(join(folder, failingFile), process.platform === 'win32' ? 0o444 : 0o000);
    const linkFolder = join(await makeTemporaryFolder(), 'link');
    await symlink(folder, linkFolder, 'junction');

    try {
      const { status, stdout, stderr } = runCommand(['build', 'entry.js', '--out', 'out.js'], folder);
      const throughLink = runCommand(['build', join(folder, 'entry.js'), '--out', join(folder, 'out.js')], linkFolder);
      assert.deepEqual({ status, stdout, stderr }, { status: 2, stdout: '', stderr: `dwfb build: Could not read or write ${failingFile} ${expected}.\n` });
      assert.deepEqual(throughLink, { status: 2, stdout: '', stderr: `dwfb build: Could not read or write ${failingFile} ${expected}.\n` });
    } finally {
      await chmod(join(folder, failingFile), 0o644);
    }
  });

  it('names the path of a file system failure as given when a folder above it cannot be searched', async (context) => {
    if (process.platform === 'win32') return context.skip('Windows has no search permission on a folder');
    if (process.getuid?.() === 0) return context.skip('root searches every folder');
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\n');
    await mkdir(join(folder, 'locked', 'dist'), { recursive: true });
    await chmod(join(folder, 'locked'), 0o000);

    try {
      const { status, stdout, stderr } = runCommand(['build', 'entry.js', '--out', 'locked/dist/out.js'], folder);
      assert.deepEqual({ status, stdout }, { status: 2, stdout: '' });
      assert.match(stderr, /^dwfb build: Could not read or write locked\/dist\/out\.js \(\w+ EACCES\)\.\n$/);
    } finally {
      await chmod(join(folder, 'locked'), 0o755);
    }
  });

  it('names the out file and the cause when --check cannot read it, and exits 2', async (context) => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = {};\n');
    await writeFile(join(folder, 'out.js'), '');
    if (process.platform === 'win32') return context.skip('Windows reads every file that chmod changes');
    if (process.getuid?.() === 0) return context.skip('root reads every file');
    await chmod(join(folder, 'out.js'), 0o000);

    try {
      const { status, stdout, stderr } = runCommand(['build', 'entry.js', '--out', 'out.js', '--check'], folder);
      assert.deepEqual({ status, stdout, stderr }, { status: 2, stdout: '', stderr: 'dwfb build: Could not read or write out.js (open EACCES).\n' });
    } finally {
      await chmod(join(folder, 'out.js'), 0o644);
    }
  });
});

describe('dwfb build with a config file', () => {
  /**
   * Copies the config project fixture into a temporary folder, so that its builds write there.
   * @returns {Promise<string>}
   */
  async function copyProjectFixture() {
    const folder = await makeTemporaryFolder();
    await cp(join(CONFIG_FIXTURES, 'project'), folder, { recursive: true });
    return folder;
  }

  it('builds every workflow of the config file, in order', async () => {
    const folder = await copyProjectFixture();

    const { status, stdout, stderr } = runCommand(['build'], folder);
    const review = await readFile(join(folder, 'dist', 'review.js'), 'utf8');
    const summary = await readFile(join(folder, 'dist', 'summary.js'), 'utf8');

    assert.deepEqual({ status, stderr }, { status: 0, stderr: '' });
    assert.equal(stdout, `Built dist/review.js from 3 source files, ${Buffer.byteLength(review)} bytes.\nBuilt dist/summary.js from 2 source files, ${Buffer.byteLength(summary)} bytes.\n`);
    assert.match(review, /^\/\/ Built by dynamic-workflow-bundler from \.\.\/workflows\/review\/entry\.js\./m);
    assert.doesNotMatch(summary, /Built by dynamic-workflow-bundler/);
  });

  it('finds a script stale after a source edit, names it and maps its first differing line to the edited source line', async () => {
    const folder = await copyProjectFixture();
    runCommand(['build'], folder);
    const fresh = runCommand(['build', '--check'], folder);
    const checklist = join(folder, 'workflows', 'review', 'checklist.md');
    await writeFile(checklist, (await readFile(checklist, 'utf8')).replace('Each message', 'Every message'));
    const built = (await readFile(join(folder, 'dist', 'review.js'), 'utf8')).split('\n');
    const builtLine = built.indexOf('- Each message names its cause.') + 1;

    const stale = runCommand(['build', '--check'], folder);
    const json = runCommand(['build', '--check', '--json'], folder);

    assert.deepEqual(fresh, { status: 0, stdout: 'dist/review.js matches its source.\ndist/summary.js matches its source.\n', stderr: '' });
    assert.equal(stale.status, 1);
    assert.equal(
      stale.stdout,
      `dist/review.js:${builtLine} differs from the script the build gives. The line comes from workflows/review/checklist.md:2. Run dwfb build.\ndist/summary.js matches its source.\n`,
    );
    assert.equal(json.status, 1);
    assert.deepEqual(
      JSON.parse(json.stdout).workflows.map(({ out, status, firstDifference }) => ({ out, status, firstDifference })),
      [
        { out: 'dist/review.js', status: 'stale', firstDifference: { line: builtLine, file: 'workflows/review/checklist.md', sourceLine: 2 } },
        { out: 'dist/summary.js', status: 'fresh', firstDifference: undefined },
      ],
    );
    assert.equal(JSON.parse(json.stdout).ok, false);
    assert.equal(await readFile(join(folder, 'dist', 'review.js'), 'utf8'), built.join('\n'));
  });

  it('reports a missing script and a workflow with a finding, and builds the workflows after the finding', async () => {
    const folder = await copyProjectFixture();
    await writeFile(join(folder, 'workflows', 'review', 'prompts.js'), 'export let reviewPrompt = () => "";\n');

    const checked = runCommand(['build', '--check'], folder);
    const built = runCommand(['build', '--json'], folder);

    assert.equal(checked.status, 1);
    assert.equal(
      checked.stdout,
      `workflows/review/prompts.js:1:1 export-not-constant The module exports a let binding. Export a const, and keep state that changes in an exported object or function.\ndist/summary.js does not exist. Run dwfb build.\n`,
    );
    assert.equal(built.status, 1);
    assert.deepEqual(JSON.parse(built.stdout).workflows.map(({ status }) => status), ['failed', 'written']);
    assert.deepEqual(await readdir(join(folder, 'dist')), ['summary.js']);
  });

  it('names the --config file in the command that rewrites a missing script', async () => {
    const folder = await copyProjectFixture();

    const { status, stdout } = runCommand(['build', '--config', 'dwfb.config.js', '--check'], folder);

    assert.equal(status, 1);
    assert.equal(stdout, 'dist/review.js does not exist. Run dwfb build --config dwfb.config.js.\ndist/summary.js does not exist. Run dwfb build --config dwfb.config.js.\n');
  });

  it('exits 2 and writes nothing when one workflow writes a source of another workflow', async () => {
    const folder = await makeTemporaryFolder();
    const library = 'export const a = 1;\n';
    await mkdir(join(folder, 'w'));
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(folder, 'w', 'b.js'), "export const meta = {};\nimport { a } from './lib.js';\nreturn a;\n");
    await writeFile(join(folder, 'w', 'lib.js'), library);
    await writeFile(join(folder, 'w', 'a.js'), 'export const meta = {};\nreturn 1;\n');
    await writeFile(join(folder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'w/b.js', out: 'dist/b.js' }, { entry: 'w/a.js', out: 'w/lib.js' }] };\n");
    const expected = {
      status: 2,
      stdout: '',
      stderr: 'dwfb build: The out file w/lib.js of the workflow whose entry is w/a.js is a source of the workflow whose entry is w/b.js.\n',
    };

    const built = runCommand(['build'], folder);
    const checked = runCommand(['build', '--check'], folder);

    assert.deepEqual(built, expected);
    assert.deepEqual(checked, expected);
    assert.equal(await readFile(join(folder, 'w', 'lib.js'), 'utf8'), library);
    assert.ok(!(await readdir(folder)).includes('dist'));
  });

  it('exits 2 and writes nothing when two workflows write one file through a link that the out file is not in yet', async () => {
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'dist'));
    await symlink(join(folder, 'dist'), join(folder, 'linked'), 'junction');
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(folder, 'a.js'), 'export const meta = {};\nreturn 1;\n');
    await writeFile(join(folder, 'b.js'), 'export const meta = {};\nreturn 2;\n');
    await writeFile(join(folder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'dist/out.js' }, { entry: 'b.js', out: 'linked/Out.js' }] };\n");
    const expected = {
      status: 2,
      stdout: '',
      stderr: 'dwfb build: The out file linked/Out.js of the workflow whose entry is b.js names the same file as the out file dist/out.js of the workflow whose entry is a.js.\n',
    };

    const built = runCommand(['build'], folder);
    const checked = runCommand(['build', '--check'], folder);

    assert.deepEqual(built, expected);
    assert.deepEqual(checked, expected);
    assert.deepEqual(await readdir(join(folder, 'dist')), []);
  });

  it('exits 2 for a config file that lists no workflow', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(folder, 'dwfb.config.js'), 'export default { workflows: [] };\n');
    const expected = { status: 2, stdout: '', stderr: 'dwfb build: The config file dwfb.config.js lists no workflow.\n' };

    assert.deepEqual(runCommand(['build', '--check'], folder), expected);
    assert.deepEqual(runCommand(['build', '--json'], folder), expected);
  });

  it('builds the workflow of a named entry, and lets --no-banner win over the config file', async () => {
    const folder = await copyProjectFixture();

    const { status, stdout } = runCommand(['build', join('workflows', 'review', 'entry.js'), '--no-banner'], folder);

    assert.equal(status, 0);
    assert.match(stdout, /^Built dist\/review\.js from 3 source files/);
    assert.deepEqual(await readdir(join(folder, 'dist')), ['review.js']);
    assert.doesNotMatch(await readFile(join(folder, 'dist', 'review.js'), 'utf8'), /Built by dynamic-workflow-bundler/);
  });

  it('reads the config file that --config names, with paths relative to its folder', async () => {
    const folder = await copyProjectFixture();
    await mkdir(join(folder, 'elsewhere'));

    const { status, stderr } = runCommand(['build', '--config', join('..', 'dwfb.config.js')], join(folder, 'elsewhere'));

    assert.deepEqual({ status, stderr }, { status: 0, stderr: '' });
    assert.deepEqual((await readdir(join(folder, 'dist'))).sort(), ['review.js', 'summary.js']);
  });

  it('reads no config file with --out', async () => {
    const folder = await copyProjectFixture();
    await writeFile(join(folder, 'dwfb.config.js'), 'export default {\n');

    const { status } = runCommand(['build', join('workflows', 'review', 'entry.js'), '--out', 'review.js'], folder);

    assert.equal(status, 0);
    assert.ok((await readdir(folder)).includes('review.js'));
  });

  it('exits 2 for an entry that no workflow of the config file has or that names a folder, and for a --config file that does not exist or names a folder', async () => {
    const folder = await copyProjectFixture();

    const noWorkflow = runCommand(['build', join('workflows', 'review', 'prompts.js')], folder);
    const noConfig = runCommand(['build', '--config', 'other.config.js'], folder);
    const trailingSeparator = runCommand(['build', 'workflows/review/entry.js/'], folder);
    const configFolderPath = runCommand(['build', '--config', 'dwfb.config.js/.'], folder);

    assert.deepEqual(trailingSeparator, { status: 2, stdout: '', stderr: 'dwfb build: The config file dwfb.config.js has no workflow whose entry is workflows/review/entry.js/.\n' });
    assert.deepEqual(configFolderPath, { status: 2, stdout: '', stderr: 'dwfb build: The config file dwfb.config.js/. is not a file.\n' });
    assert.deepEqual(noWorkflow, {
      status: 2,
      stdout: '',
      stderr: `dwfb build: The config file dwfb.config.js has no workflow whose entry is ${join('workflows', 'review', 'prompts.js')}.\n`,
    });
    assert.deepEqual(noConfig, { status: 2, stdout: '', stderr: 'dwfb build: The config file other.config.js does not exist.\n' });
  });

  it('reads dwfb.config.mjs in a CommonJS package, and names it in a message', async () => {
    const folder = await copyProjectFixture();
    await rename(join(folder, 'dwfb.config.js'), join(folder, 'dwfb.config.mjs'));
    await writeFile(join(folder, 'package.json'), '{ "type": "commonjs" }\n');

    const built = runCommand(['build'], folder);
    const noWorkflow = runCommand(['build', join('workflows', 'review', 'prompts.js')], folder);

    assert.deepEqual({ status: built.status, stderr: built.stderr }, { status: 0, stderr: '' });
    assert.deepEqual((await readdir(join(folder, 'dist'))).sort(), ['review.js', 'summary.js']);
    assert.deepEqual(noWorkflow, {
      status: 2,
      stdout: '',
      stderr: `dwfb build: The config file dwfb.config.mjs has no workflow whose entry is ${join('workflows', 'review', 'prompts.js')}.\n`,
    });
  });

  it('exits 2 and writes nothing when dwfb.config.js and dwfb.config.mjs both exist, and reads the one --config names', async () => {
    const folder = await copyProjectFixture();
    await cp(join(folder, 'dwfb.config.js'), join(folder, 'dwfb.config.mjs'));
    const expected = 'The config files dwfb.config.js and dwfb.config.mjs both exist here, so remove one or name one with --config <path>.\n';

    const both = runCommand(['build'], folder);
    const isDistWritten = (await readdir(folder)).includes('dist');
    const named = runCommand(['build', '--config', 'dwfb.config.mjs'], folder);
    // The summary workflow writes no banner, so locate reads the config file to find its entry.
    const locateBoth = runCommand(['locate', join('dist', 'summary.js'), '1'], folder);

    assert.deepEqual(both, { status: 2, stdout: '', stderr: `dwfb build: ${expected}` });
    assert.equal(isDistWritten, false);
    assert.deepEqual({ status: named.status, stderr: named.stderr }, { status: 0, stderr: '' });
    assert.deepEqual(locateBoth, { status: 2, stdout: '', stderr: `dwfb locate: ${expected}` });
  });

  it('names the recovery for a config file that loads as CommonJS, and no absolute path for a missing import', () => {
    const commonJs = runCommand(['build'], join(CONFIG_FIXTURES, 'commonjs-package'));
    // A config file that --config names stays named after a rename, so the rename is no recovery for it.
    const commonJsNamed = runCommand(['build', '--config', 'dwfb.config.js'], join(CONFIG_FIXTURES, 'commonjs-package'));
    const importMissing = runCommand(['build'], join(CONFIG_FIXTURES, 'import-missing'));

    assert.equal(commonJs.status, 2);
    assert.match(
      commonJs.stderr,
      /\ndwfb build: The config file dwfb\.config\.js does not load\. Unexpected token 'export'\. If the file is an ES module, set "type": "module" in the nearest package\.json, or rename it to dwfb\.config\.mjs\.\n$/,
    );
    assert.equal(commonJsNamed.status, 2);
    assert.match(
      commonJsNamed.stderr,
      /\ndwfb build: The config file dwfb\.config\.js does not load\. Unexpected token 'export'\. If the file is an ES module, set "type": "module" in the nearest package\.json, or name a \.mjs config file with --config\.\n$/,
    );
    assert.deepEqual(importMissing, {
      status: 2,
      stdout: '',
      stderr: "dwfb build: The config file dwfb.config.js does not load. Cannot find module 'missing.js' imported from dwfb.config.js.\n",
    });
  });

  it('writes no script when a later workflow has a usage error', async () => {
    const folder = await copyProjectFixture();
    await writeFile(join(folder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'workflows/review/entry.js', out: 'dist/review.js' }, { entry: 'workflows/missing.js', out: 'dist/missing.js' }] };\n");

    const { status, stdout, stderr } = runCommand(['build', '--json'], folder);

    assert.deepEqual({ status, stdout, stderr }, { status: 2, stdout: '', stderr: 'dwfb build: The entry file workflows/missing.js does not exist.\n' });
    assert.ok(!(await readdir(folder)).includes('dist'));
  });

  it('names the working directory as . for a config file entry or out that is the working directory', async () => {
    const folder = await copyProjectFixture();
    await writeFile(join(folder, 'out.config.js'), "export default { workflows: [{ entry: 'workflows/review/entry.js', out: '.' }] };\n");
    await writeFile(join(folder, 'entry.config.js'), "export default { workflows: [{ entry: '.', out: 'dist/review.js' }] };\n");

    const outFolder = runCommand(['build', '--config', 'out.config.js'], folder);
    const entryFolder = runCommand(['build', '--config', 'entry.config.js'], folder);

    assert.deepEqual(outFolder, { status: 2, stdout: '', stderr: 'dwfb build: The out path . is not a file.\n' });
    assert.deepEqual(entryFolder, { status: 2, stdout: '', stderr: 'dwfb build: The entry . is not a file.\n' });
  });

  it('prints what is wrong and exits 2 for each config file fixture of a usage error', async () => {
    // Node prints its own warning to stderr ahead of the message for a config file that loads as CommonJS.
    const names = (await readdir(CONFIG_FIXTURES)).filter((name) => name !== 'project' && name !== 'commonjs-package');

    assert.ok(names.length >= 10);
    for (const name of names) {
      const { status, stdout, stderr } = runCommand(['build'], join(CONFIG_FIXTURES, name));
      assert.equal(status, 2, name);
      assert.equal(stdout, '', name);
      assert.match(stderr, /^dwfb build: (The config file|Workflows? \d+(?: and \d+)? of the config file) dwfb\.config\.js [^\n]+\.\n$/, name);
    }
  });
});

describe('dwfb locate', () => {
  /**
   * Copies the config project fixture into a temporary folder and builds its workflows there.
   * @returns {Promise<{ folder: string, review: string[], summary: string[] }>} The folder and the lines of
   *   each built script.
   */
  async function buildProjectFixture() {
    const folder = await makeTemporaryFolder();
    await cp(join(CONFIG_FIXTURES, 'project'), folder, { recursive: true });
    runCommand(['build'], folder);
    const review = (await readFile(join(folder, 'dist', 'review.js'), 'utf8')).split('\n');
    const summary = (await readFile(join(folder, 'dist', 'summary.js'), 'utf8')).split('\n');
    return { folder, review, summary };
  }

  it('prints the source file, line and column, then the source line, of a script with a banner and of one the config file names', async () => {
    const { folder, review, summary } = await buildProjectFixture();
    const promptLine = review.indexOf('  return `Review this change.') + 1;
    const collectLine = summary.indexOf('const files = args.files ?? [];') + 1;

    assert.deepEqual(runCommand(['locate', 'dist/review.js', String(promptLine)], folder), { status: 0, stdout: 'workflows/review/prompts.js:2:1\n  return `Review this change.\n', stderr: '' });
    assert.deepEqual(runCommand(['locate', 'dist/review.js', `${promptLine}:10`], folder), { status: 0, stdout: 'workflows/review/prompts.js:2:10\n  return `Review this change.\n', stderr: '' });
    assert.deepEqual(runCommand(['locate', 'dist/summary.js', String(collectLine)], folder), { status: 0, stdout: 'workflows/summary/steps/collect.js:1:1\nconst files = args.files ?? [];\n', stderr: '' });
  });

  it('says that the build adds a line, and prints one JSON object with --json', async () => {
    const { folder, review } = await buildProjectFixture();
    const scopeLine = review.findIndex((line) => line.startsWith('const __dwfb_prompts_js_')) + 1;

    assert.deepEqual(runCommand(['locate', 'dist/review.js', '2'], folder), { status: 0, stdout: 'The build adds the line. It has no source line.\n', stderr: '' });
    assert.deepEqual(runCommand(['locate', 'dist/review.js', String(scopeLine)], folder), { status: 0, stdout: 'The build adds the line for workflows/review/prompts.js. It has no source line.\n', stderr: '' });
    const json = runCommand(['locate', 'dist/review.js', '1:8', '--json'], folder);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), { ok: true, file: 'workflows/review/entry.js', line: 1, column: 8, text: "export const meta = { name: 'review', description: 'Review a change' };", generated: false, findings: [] });
  });

  it('reads a line of a runtime stack trace with --runtime', async () => {
    const { folder } = await buildProjectFixture();
    const entry = join(folder, 'workflows', 'review', 'entry.js');
    await writeFile(entry, (await readFile(entry, 'utf8')).replace("export const meta = { name: 'review', description: 'Review a change' };", "export const meta = {\n  name: 'review',\n  description: 'Review a change',\n};"));
    runCommand(['build'], folder);
    const review = (await readFile(join(folder, 'dist', 'review.js'), 'utf8')).split('\n');
    const returnLine = review.indexOf('return await agent(reviewPrompt(args.change, checklist));') + 1;

    // The meta statement ends on line 4 and the banner is line 5, so runtime line R is script line R + 3.
    assert.deepEqual(runCommand(['locate', 'dist/review.js', `${returnLine - 3}:14`, '--runtime'], folder), runCommand(['locate', 'dist/review.js', `${returnLine}:14`], folder));
    assert.equal(runCommand(['locate', 'dist/review.js', `${returnLine - 3}:14`, '--runtime'], folder).stdout, 'workflows/review/entry.js:9:14\nreturn await agent(reviewPrompt(args.change, checklist));\n');
  });

  it('builds from the entry that --entry names, and reads the config file that --config names', async () => {
    const { folder, summary } = await buildProjectFixture();
    const collectLine = summary.indexOf('const files = args.files ?? [];') + 1;
    await cp(join(folder, 'workflows', 'review'), join(folder, 'copy'), { recursive: true });
    await cp(join(folder, 'dwfb.config.js'), join(folder, 'other.config.js'));
    await rm(join(folder, 'dwfb.config.js'));

    const fromEntry = runCommand(['locate', 'dist/review.js', '1', '--entry', 'copy/entry.js'], folder);
    const fromConfig = runCommand(['locate', 'dist/summary.js', String(collectLine), '--config', 'other.config.js'], folder);

    assert.deepEqual({ status: fromEntry.status, stderr: fromEntry.stderr }, { status: 1, stderr: '' });
    assert.match(fromEntry.stdout, /^dist\/review\.js:2:1 script-stale .* Run dwfb build copy\/entry\.js --out dist\/review\.js, since/);
    assert.deepEqual(fromConfig, { status: 0, stdout: 'workflows/summary/steps/collect.js:1:1\nconst files = args.files ?? [];\n', stderr: '' });
    assert.equal(runCommand(['locate', 'dist/summary.js', String(collectLine)], folder).status, 2);
  });

  it('prints script-stale and exits 1 for a script that differs from its source, with the command that rewrites it', async () => {
    const { folder, review } = await buildProjectFixture();
    const checklist = join(folder, 'workflows', 'review', 'checklist.md');
    await writeFile(checklist, (await readFile(checklist, 'utf8')).replace('Each message', 'Every message'));
    const checklistLine = review.indexOf('- Each message names its cause.') + 1;

    const { status, stdout, stderr } = runCommand(['locate', 'dist/review.js', '1'], folder);
    runCommand(['build', 'workflows/review/entry.js', '--out', 'dist/review.js'], folder);

    assert.deepEqual({ status, stderr }, { status: 1, stderr: '' });
    assert.equal(stdout, `dist/review.js:${checklistLine}:1 script-stale The script differs from the script the build gives. Run dwfb build workflows/review/entry.js --out dist/review.js, since the line numbers may not match the source.\n`);
    assert.equal(runCommand(['locate', 'dist/review.js', '1'], folder).status, 0);
  });

  it('exits 2 for a missing script or line, a line that is not a whole number of 1 or more, is too large or lies past the script, and an empty option', async () => {
    const { folder, review } = await buildProjectFixture();
    const cases = [
      [['locate'], /^dwfb locate: Name one built script and one line\.\n\nUsage: dwfb locate/],
      [['locate', 'dist/review.js'], /^dwfb locate: Name one built script and one line\./],
      [['locate', 'dist/review.js', ''], /^dwfb locate: Name one built script and one line\./],
      [['locate', 'dist/review.js', 'x'], /^dwfb locate: The line x is not a whole number, or a line and a column such as 12:5\./],
      [['locate', 'dist/review.js', '3:'], /^dwfb locate: The line 3: is not a whole number/],
      [['locate', 'dist/review.js', '0'], /^dwfb locate: The line 0 is not a whole number of 1 or more\.\n$/],
      [['locate', 'dist/review.js', '9007199254740993'], /^dwfb locate: The line 9007199254740993 is larger than 9007199254740991\.\n\nUsage: dwfb locate/],
      [['locate', 'dist/review.js', '1:999999999999999999999'], /^dwfb locate: The column 999999999999999999999 is larger than 9007199254740991\.\n\nUsage: dwfb locate/],
      [['locate', 'dist/review.js', `${review.length}`], new RegExp(`^dwfb locate: The script dist/review\.js ends on line ${review.length - 1}, so line ${review.length} is past its end\.\n$`)],
      [['locate', 'dist/missing.js', '1'], /^dwfb locate: The script file dist\/missing\.js does not exist\.\n$/],
      [['locate', 'dist/review.js', '1', '--entry', ''], /^dwfb locate: Name the entry file with --entry <file>\./],
      [['locate', 'dist/review.js', '1', '--config', ''], /^dwfb locate: Name the config file with --config <path>\./],
      [['locate', 'dist/review.js', '1', '--verbose'], /^dwfb locate: Unknown option '--verbose'/],
    ];

    for (const [args, message] of cases) {
      const { status, stdout, stderr } = runCommand(args, folder);
      assert.deepEqual({ status, stdout }, { status: 2, stdout: '' }, args.join(' '));
      assert.match(stderr, message, args.join(' '));
    }
  });

  it('prints its usage for locate --help, and the main usage lists it', () => {
    assert.match(runCommand(['locate', '--help']).stdout, /^Usage: dwfb locate <script> <line>\[:<column>\] \[options\]\n/);
    assert.match(runCommand(['--help']).stdout, /\n {2}locate <script> <line>\[:<column>\]\n/);
  });
});
