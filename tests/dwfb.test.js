import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { formatFlowMap } from '../src/format-flow-map.js';
import { map as mapLibrary } from '../src/map.js';
import { READ_BYTE_LIMIT } from '../src/read-byte-limit.js';
import { listMissingGlobalNames } from '../src/run-simulation.js';
import { sliceMarkdownSection } from './support/slice-markdown-section.js';
import { writeSizedFile } from './support/write-sized-file.js';

const COMMAND = fileURLToPath(new URL('../bin/dwfb.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const MODULES_ENTRY = join(FIXTURES, 'modules', 'entry.js');
const CONFIG_FIXTURES = join(FIXTURES, 'config');
const PACKAGE = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const README_SIMULATE_HEADING = '\n## dwfb simulate\n';
const README_FILE_PATTERN = /^`(?<path>[^`\n]+)`:\n\n```js\n(?<code>[^]*?)```$/gm;

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
 * @param {number} [timeout] Milliseconds before the command is killed, which leaves `status` null.
 */
function runCommand(args, cwd = process.cwd(), timeout = undefined) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [COMMAND, ...args], { cwd, encoding: 'utf8', timeout });
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
    assert.match(buildHelp.stdout, /\n {2}--no-banner {7}Leave out the banner line\.\n {2}--no-validate {5}Skip the check of the built script against the runtime's contract\.\n/);
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
    await writeFile(join(realFolder, 'entry.js'), "export const meta = { name: 'p', description: 'd' };\nimport { a } from './a.js';\nreturn a;\n");
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
    await writeFile(join(realFolder, 'entry.js'), "export const meta = { name: 'p', description: 'd' };\nimport { a } from './a.js';\nreturn a;\n");
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
    await writeFile(join(folder, 'entry.js'), "export const meta = { name: 'p', description: 'd' };\nimport { a } from './a.js';\nreturn a;\n");
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
    await writeFile(join(folder, 'entry.js'), 'export const meta = { name: "p", description: "d" };\nreturn 1;\n');

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

  it('prints a contract finding of the built script at its source line and exits 1, and builds it with --no-validate', async () => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), 'export const meta = { name: "p", description: "d" };\nimport { stamp } from \'./clock.js\';\nreturn stamp();\n');
    await writeFile(join(folder, 'clock.js'), 'export function stamp() {\n  return Date.now();\n}\n');

    const refused = runCommand(['build', 'entry.js', '--out', 'out.js'], folder);
    const missing = runCommand(['build', 'entry.js', '--out', 'out.js', '--no-validate', '--check'], folder);
    const built = runCommand(['build', 'entry.js', '--out', 'out.js', '--no-validate'], folder);

    assert.deepEqual(refused, {
      status: 1,
      stdout: 'clock.js:2:10 clock-unavailable The script uses Date.now, which throws in the runtime when called. Pass the time through args, or stamp the result after the workflow returns.\n',
      stderr: '',
    });
    assert.equal(missing.stdout, 'out.js does not exist. Run dwfb build entry.js --out out.js --no-validate.\n');
    assert.equal(built.status, 0);
    assert.match(built.stdout, /^Built out\.js from 2 source files, \d+ bytes\.\n$/);
  });

  it('names the file and the cause of a file system failure, exits 2 and prints no stack', async (context) => {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'entry.js'), "export const meta = { name: 'p', description: 'd' };\nimport './a.js';\n");
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
    await writeFile(join(folder, 'entry.js'), 'export const meta = { name: "p", description: "d" };\n');
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
    await writeFile(join(folder, 'entry.js'), 'export const meta = { name: "p", description: "d" };\n');
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
    await writeFile(join(folder, 'w', 'b.js'), "export const meta = { name: 'p', description: 'd' };\nimport { a } from './lib.js';\nreturn a;\n");
    await writeFile(join(folder, 'w', 'lib.js'), library);
    await writeFile(join(folder, 'w', 'a.js'), 'export const meta = { name: "p", description: "d" };\nreturn 1;\n');
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
    await writeFile(join(folder, 'a.js'), 'export const meta = { name: "p", description: "d" };\nreturn 1;\n');
    await writeFile(join(folder, 'b.js'), 'export const meta = { name: "p", description: "d" };\nreturn 2;\n');
    await writeFile(join(folder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'dist/out.js' }, { entry: 'b.js', out: 'linked/Out.js' }] };\n");
    const expected = {
      status: 2,
      stdout: '',
      stderr: 'dwfb build: The out file linked/Out.js of the workflow whose entry is b.js names the same file as the out file dist/out.js of the workflow whose entry is a.js where file names ignore letter case.\n',
    };

    const built = runCommand(['build'], folder);
    const checked = runCommand(['build', '--check'], folder);

    assert.deepEqual(built, expected);
    assert.deepEqual(checked, expected);
    assert.deepEqual(await readdir(join(folder, 'dist')), []);
  });

  it('exits 2 and writes nothing when an out names a scenarios file through a link', async () => {
    const folder = await makeTemporaryFolder();
    const scenarios = "export default [{ name: 'a' }];\n";
    await mkdir(join(folder, 'tests'));
    await symlink(join(folder, 'tests'), join(folder, 'linked'), 'junction');
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(folder, 'a.js'), 'export const meta = { name: "p", description: "d" };\nreturn 1;\n');
    await writeFile(join(folder, 'tests', 's.js'), scenarios);
    await writeFile(join(folder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'linked/s.js', scenarios: 'tests/s.js' }] };\n");
    const expected = {
      status: 2,
      stdout: '',
      stderr: 'dwfb build: The out file linked/s.js of the workflow whose entry is a.js names the scenarios file tests/s.js of the workflow whose entry is a.js.\n',
    };

    const built = runCommand(['build'], folder);
    const checked = runCommand(['build', '--check'], folder);

    assert.deepEqual(built, expected);
    assert.deepEqual(checked, expected);
    assert.equal(await readFile(join(folder, 'tests', 's.js'), 'utf8'), scenarios);
  });

  it('exits 2 and writes nothing when an out names a scenarios file that is not there yet through a link in another letter case', async () => {
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'tests'));
    await symlink(join(folder, 'tests'), join(folder, 'linked'), 'junction');
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(folder, 'a.js'), 'export const meta = { name: "p", description: "d" };\nreturn 1;\n');
    await writeFile(join(folder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'linked/S.js', scenarios: 'tests/s.js' }] };\n");
    const expected = {
      status: 2,
      stdout: '',
      stderr: 'dwfb build: The out file linked/S.js of the workflow whose entry is a.js names the scenarios file tests/s.js of the workflow whose entry is a.js where file names ignore letter case.\n',
    };

    const built = runCommand(['build'], folder);
    const checked = runCommand(['build', '--check'], folder);

    assert.deepEqual(built, expected);
    assert.deepEqual(checked, expected);
    assert.deepEqual(await readdir(join(folder, 'tests')), []);
  });

  it('exits 2 and keeps the bytes of the config file when an out names the config file the command read, by any spelling', async () => {
    const folder = await makeTemporaryFolder();
    const configText = "export default { workflows: [{ entry: 'a.js', out: 'c.js' }] };\n";
    const linkConfigText = "export default { workflows: [{ entry: '../a.js', out: '../linked/c.js' }] };\n";
    await mkdir(join(folder, 'conf'));
    await symlink(join(folder, 'conf'), join(folder, 'linked'), 'junction');
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(folder, 'a.js'), 'export const meta = { name: "p", description: "d" };\nreturn 1;\n');
    await writeFile(join(folder, 'c.js'), configText);
    await writeFile(join(folder, 'conf', 'c.js'), linkConfigText);
    const cases = [
      [['build', '--config', 'c.js'], 'dwfb build: Workflow 1 of the config file c.js writes c.js, which names the config file.\n'],
      [['build', '--config', 'conf/c.js'], 'dwfb build: The out file linked/c.js of the workflow whose entry is a.js names the config file conf/c.js, which the write would replace.\n'],
      [['build', '--config', 'conf/c.js', '--check'], 'dwfb build: The out file linked/c.js of the workflow whose entry is a.js names the config file conf/c.js, which the write would replace.\n'],
    ];

    for (const [args, stderr] of cases) assert.deepEqual(runCommand(args, folder), { status: 2, stdout: '', stderr }, args.join(' '));
    assert.equal(await readFile(join(folder, 'c.js'), 'utf8'), configText);
    assert.equal(await readFile(join(folder, 'conf', 'c.js'), 'utf8'), linkConfigText);
  });

  it('names each script written before a failed write, with and without --json, and exits 2', async (context) => {
    if (process.getuid?.() === 0) return context.skip('root writes every folder');
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'first'));
    await mkdir(join(folder, 'second'));
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(folder, 'a.js'), 'export const meta = { name: "p", description: "d" };\nreturn 1;\n');
    await writeFile(join(folder, 'c.js'), 'export const meta = { name: "p", description: "d" };\nreturn 3;\n');
    await writeFile(join(folder, 'b.js'), 'export const meta = { name: "p", description: "d" };\nreturn 2;\n');
    await writeFile(join(folder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'first/a.js' }, { entry: 'c.js', out: 'first/c.js' }, { entry: 'b.js', out: 'second/b.js' }] };\n");
    await writeFile(join(folder, 'second', 'b.js'), 'old\n');
    // Windows refuses a rename over a read-only file, and POSIX refuses to create a file in a folder with no write permission.
    const lockedPath = process.platform === 'win32' ? join(folder, 'second', 'b.js') : join(folder, 'second');
    const cause = process.platform === 'win32' ? '(rename EPERM)' : '(open EACCES)';
    const stderr = `dwfb build: Could not read or write second/b.js ${cause}. Wrote first/a.js, first/c.js before the failure.\n`;
    const resetFirst = async () => {
      await writeFile(join(folder, 'first', 'a.js'), 'old\n');
      await writeFile(join(folder, 'first', 'c.js'), 'old\n');
    };
    await chmod(lockedPath, process.platform === 'win32' ? 0o444 : 0o555);

    try {
      await resetFirst();
      const plain = runCommand(['build'], folder);
      const plainFirst = [await readFile(join(folder, 'first', 'a.js'), 'utf8'), await readFile(join(folder, 'first', 'c.js'), 'utf8')];
      await resetFirst();
      const json = runCommand(['build', '--json'], folder);
      const jsonFirst = [await readFile(join(folder, 'first', 'a.js'), 'utf8'), await readFile(join(folder, 'first', 'c.js'), 'utf8')];

      assert.equal(plain.status, 2);
      assert.match(plain.stdout, /^Built first\/a\.js from 1 source file, \d+ bytes\.\nBuilt first\/c\.js from 1 source file, \d+ bytes\.\n$/);
      assert.equal(plain.stderr, stderr);
      assert.deepEqual(json, { status: 2, stdout: '', stderr });
      for (const [index, text] of [...plainFirst, ...jsonFirst].entries()) assert.match(text, index % 2 === 0 ? /\nreturn 1;\n/ : /\nreturn 3;\n/);
      assert.equal(await readFile(join(folder, 'second', 'b.js'), 'utf8'), 'old\n');
    } finally {
      await chmod(lockedPath, process.platform === 'win32' ? 0o644 : 0o755);
    }
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

describe('dwfb simulate', () => {
  const META = "export const meta = { name: 'p', description: 'd' };\n";
  const SIMULATE_FIXTURES = join(FIXTURES, 'simulate');
  const README_RUN_PATTERN = /^\$ dwfb (?<args>simulate [^\n]*)\n(?<output>[^]*?)```$/m;
  const USED_UP_MESSAGE = 'The list of key "review" holds 1 scripted return, which earlier calls used up, so it has none for call 2 (label "review"). Add a scripted return to the list';
  const NO_LABEL_MESSAGE = "No key of respond matches call 0 (no label). Add the key '', which matches a call with no label";
  const CLOCK_FINDING = 'clock.js:2:8 clock-unavailable The script uses Date.now, which throws in the runtime when called. Pass the time through args, or stamp the result after the workflow returns.';
  const SCENARIO_FILES = Object.freeze({
    'review.scenarios.js': "export default [\n  { name: 'passes', respond: { draft: 'the draft', review: { verdict: 'pass' } } },\n  { name: 'used up', respond: { draft: 'the draft', review: [{ verdict: 'fail' }] } },\n];\n",
    'answer.scenarios.js': "export default [\n  { name: 'answer died', expect: 'threw', respond: { answer: null } },\n  { name: 'answer given', expect: 'threw', respond: { answer: 'yes' } },\n];\n",
    'unlabeled.scenarios.js': "export default [\n  { name: 'no key', args: { calls: [null] }, respond: {} },\n  { name: 'empty list', args: { calls: [{ label: 'no label' }] }, respond: { '': [] } },\n];\n",
    'any.scenarios.js': "export default [{ name: 'first' }, { name: 'second' }];\n",
  });

  /**
   * @returns {Promise<string>} A new folder of an ES module package that holds the scripts and the scenarios
   *   files of these tests.
   */
  async function writeSimulateFolder() {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    for (const name of ['review-loop', 'call-each', 'reads-temporal']) await cp(join(SIMULATE_FIXTURES, `${name}.js`), join(folder, `${name}.js`));
    await writeFile(join(folder, 'answer.js'), `${META}const answer = await agent('Answer', { label: 'answer' });\nif (answer === null) throw new TypeError('The answer agent died');\nreturn answer;\n`);
    await writeFile(join(folder, 'clock.js'), `${META}return Date.now();\n`);
    await writeFile(join(folder, 'waits.js'), `${META}await new Promise(() => {});\n`);
    for (const [file, text] of Object.entries(SCENARIO_FILES)) await writeFile(join(folder, file), text);
    return folder;
  }

  it('prints a line per scenario for a return and a stop at a call with a label, then the counts, and exits 1 when one failed', async () => {
    const folder = await writeSimulateFolder();

    assert.deepEqual(runCommand(['simulate', 'review-loop.js', '--scenarios', 'review.scenarios.js'], folder), {
      status: 1,
      stdout: `review-loop.js passes: returned, 2 calls.\nFAILED review-loop.js used up: stopped at call 2 (label "review"): ${USED_UP_MESSAGE}, 3 calls.\n1 passed, 1 failed.\n`,
      stderr: '',
    });
    assert.deepEqual(runCommand(['simulate', 'review-loop.js', '--scenarios', 'review.scenarios.js', '--scenario', 'passes'], folder), {
      status: 0,
      stdout: 'review-loop.js passes: returned, 2 calls.\n1 passed, 0 failed.\n',
      stderr: '',
    });
  });

  it('passes a scenario that expects threw when the script throws, and fails it when the script returns', async () => {
    const folder = await writeSimulateFolder();

    assert.deepEqual(runCommand(['simulate', 'answer.js', '--scenarios', 'answer.scenarios.js'], folder), {
      status: 1,
      stdout: 'answer.js answer died: threw TypeError: The answer agent died, 1 call.\nFAILED answer.js answer given: returned, 1 call.\n1 passed, 1 failed.\n',
      stderr: '',
    });
  });

  it('names a stop at a call with no label apart from a stop at a call labeled no label', async () => {
    const folder = await writeSimulateFolder();
    const emptyListMessage = 'The list of key "" is empty, so it has none for call 0 (label "no label"). Add a scripted return to the list';

    assert.deepEqual(runCommand(['simulate', 'call-each.js', '--scenarios', 'unlabeled.scenarios.js'], folder), {
      status: 1,
      stdout: `FAILED call-each.js no key: stopped at call 0 (no label): ${NO_LABEL_MESSAGE}, 1 call.\nFAILED call-each.js empty list: stopped at call 0 (label "no label"): ${emptyListMessage}, 1 call.\n0 passed, 2 failed.\n`,
      stderr: '',
    });
  });

  it('prints the findings of a refused script once, before its lines', async () => {
    const folder = await writeSimulateFolder();

    assert.deepEqual(runCommand(['simulate', 'clock.js', '--scenarios', 'any.scenarios.js'], folder), {
      status: 1,
      stdout: `${CLOCK_FINDING}\nFAILED clock.js first: refused, 0 calls.\nFAILED clock.js second: refused, 0 calls.\n0 passed, 2 failed.\n`,
      stderr: '',
    });
  });

  const definedName = listMissingGlobalNames().includes('Temporal') ? false : `Node ${process.version} defines Temporal`;
  it('prints a stop before the script runs with no call', { skip: definedName }, async () => {
    const folder = await writeSimulateFolder();
    const message = `The script reads Temporal, which the runtime defines and Node ${process.version} does not, so the simulation cannot run it. Run it on a Node that defines Temporal`;

    assert.deepEqual(runCommand(['simulate', 'reads-temporal.js', '--scenarios', 'any.scenarios.js', '--scenario', 'first'], folder), {
      status: 1,
      stdout: `FAILED reads-temporal.js first: stopped: ${message}, 0 calls.\n0 passed, 1 failed.\n`,
      stderr: '',
    });
  });

  it('prints a stop with no call for a script that waits on a promise that nothing settles, and exits 1', async () => {
    const folder = await writeSimulateFolder();
    const message = 'The script waits on a promise that nothing settles. A run of this script would not end';

    assert.deepEqual(runCommand(['simulate', 'waits.js', '--scenarios', 'any.scenarios.js', '--scenario', 'first'], folder), {
      status: 1,
      stdout: `FAILED waits.js first: stopped: ${message}, 0 calls.\n0 passed, 1 failed.\n`,
      stderr: '',
    });
  });

  it('prints a stop at the call after the 1000th with the call it names, and exits 1', async () => {
    const folder = await writeSimulateFolder();
    const message = 'The script made more than 1000 agent() calls, the cap the runtime puts on one workflow. Check the code that makes call 1000 (label "find")';
    await writeFile(join(folder, 'find-loop.js'), `${META}const bugs = [];\nwhile (bugs.length < 10) {\n  const found = await agent('Find bugs', { label: 'find', schema: { type: 'object' } });\n  bugs.push(...found.bugs);\n}\nreturn bugs;\n`);
    await writeFile(join(folder, 'find.scenarios.js'), "export default [{ name: 'no bugs', respond: { find: { bugs: [] } } }];\n");

    // The loop never ends without the cap, so the timeout fails the test rather than hang the suite.
    assert.deepEqual(runCommand(['simulate', 'find-loop.js', '--scenarios', 'find.scenarios.js'], folder, 60_000), {
      status: 1,
      stdout: `FAILED find-loop.js no bugs: stopped at call 1000 (label "find"): ${message}, 1001 calls.\n0 passed, 1 failed.\n`,
      stderr: '',
    });
  });

  it('writes each hidden character of a scenario name as its escape, in a result line and in a usage error', async () => {
    const folder = await writeSimulateFolder();
    await writeFile(join(folder, 'tab.scenarios.js'), "export default [{ name: 'a\\tb', expect: 'threw', respond: { answer: null } }];\n");

    assert.deepEqual(runCommand(['simulate', 'answer.js', '--scenarios', 'tab.scenarios.js'], folder), {
      status: 0,
      stdout: 'answer.js a\\u{0009}b: threw TypeError: The answer agent died, 1 call.\n1 passed, 0 failed.\n',
      stderr: '',
    });
    assert.deepEqual(runCommand(['simulate', 'answer.js', '--scenarios', 'tab.scenarios.js', '--scenario', 'x\ty'], folder), {
      status: 2,
      stdout: '',
      stderr: 'dwfb simulate: The scenarios file tab.scenarios.js holds no scenario named "x\\u{0009}y".\n',
    });
  });

  it('prints one JSON object with --json, with the trace of each simulation', async () => {
    const folder = await writeSimulateFolder();
    const { status, stdout, stderr } = runCommand(['simulate', 'answer.js', '--scenarios', 'answer.scenarios.js', '--json'], folder);
    const answerCall = { index: 0, label: 'answer', prompt: 'Answer', opts: { label: 'answer' }, group: null, phase: null };
    const traceHead = { script: 'answer.js', runtime: '2.1.332' };
    const traceTail = { groups: [], phases: [], logs: [], events: [{ kind: 'call', index: 0 }] };

    assert.deepEqual({ status, stderr }, { status: 1, stderr: '' });
    assert.deepEqual(JSON.parse(stdout), {
      ok: false,
      runtime: '2.1.332',
      simulations: [
        {
          script: 'answer.js',
          scenario: 'answer died',
          expect: 'threw',
          passed: true,
          trace: { ...traceHead, scenario: 'answer died', end: { kind: 'threw', name: 'TypeError', message: 'The answer agent died', frames: [{ line: 3, column: 28 }] }, calls: [{ ...answerCall, returned: null }], ...traceTail },
        },
        {
          script: 'answer.js',
          scenario: 'answer given',
          expect: 'threw',
          passed: false,
          trace: { ...traceHead, scenario: 'answer given', end: { kind: 'returned', value: 'yes' }, calls: [{ ...answerCall, returned: 'yes' }], ...traceTail },
        },
      ],
    });
  });

  it('runs the out of each workflow of the config file that has scenarios, and skips the others with no line', async () => {
    const folder = await writeSimulateFolder();
    const config = "export default { workflows: [{ entry: 'clock.js', out: 'clock.js', validate: false }, { entry: 'answer.js', out: 'dist/answer.js', scenarios: 'answer.scenarios.js' }] };\n";
    const expected = { status: 1, stdout: 'dist/answer.js answer died: threw TypeError: The answer agent died, 1 call.\nFAILED dist/answer.js answer given: returned, 1 call.\n1 passed, 1 failed.\n', stderr: '' };
    await mkdir(join(folder, 'dist'));
    await cp(join(folder, 'answer.js'), join(folder, 'dist', 'answer.js'));
    await writeFile(join(folder, 'dwfb.config.js'), config);
    await writeFile(join(folder, 'other.config.js'), config);

    assert.deepEqual(runCommand(['simulate'], folder), expected);
    await rm(join(folder, 'dwfb.config.js'));
    assert.deepEqual(runCommand(['simulate', '--config', 'other.config.js'], folder), expected);
  });

  it('runs a named script with no --scenarios against the scenarios of the config workflow whose out is the script', async () => {
    const folder = await writeSimulateFolder();
    const config = "export default { workflows: [{ entry: 'clock.js', out: 'clock.js', validate: false }, { entry: 'answer.js', out: 'dist/answer.js', scenarios: 'answer.scenarios.js' }] };\n";
    const expected = { status: 1, stdout: 'dist/answer.js answer died: threw TypeError: The answer agent died, 1 call.\nFAILED dist/answer.js answer given: returned, 1 call.\n1 passed, 1 failed.\n', stderr: '' };
    await mkdir(join(folder, 'dist'));
    await cp(join(folder, 'answer.js'), join(folder, 'dist', 'answer.js'));
    await writeFile(join(folder, 'dwfb.config.js'), config);
    await writeFile(join(folder, 'other.config.js'), config);

    assert.deepEqual(runCommand(['simulate', 'dist/answer.js'], folder), expected);
    await rm(join(folder, 'dwfb.config.js'));
    assert.deepEqual(runCommand(['simulate', 'dist/answer.js', '--config', 'other.config.js'], folder), expected);
  });

  it('loads a scenarios file once, so its top-level state carries over to a later workflow that names the same file', async () => {
    const folder = await writeSimulateFolder();
    const scenarios = "let calls = 0;\nexport default [{ name: 'first answer', respond: { answer: () => { calls += 1; return calls === 1 ? 'yes' : null; } } }];\n";
    const config = "export default { workflows: [{ entry: 'answer.js', out: 'answer.js', scenarios: 'counted.scenarios.js' }, { entry: 'answer.js', out: 'dist/answer.js', scenarios: 'counted.scenarios.js' }] };\n";
    await mkdir(join(folder, 'dist'));
    await cp(join(folder, 'answer.js'), join(folder, 'dist', 'answer.js'));
    await writeFile(join(folder, 'counted.scenarios.js'), scenarios);
    await writeFile(join(folder, 'dwfb.config.js'), config);

    assert.deepEqual(runCommand(['simulate'], folder), {
      status: 1,
      stdout: 'answer.js first answer: returned, 1 call.\nFAILED dist/answer.js first answer: threw TypeError: The answer agent died, 1 call.\n1 passed, 1 failed.\n',
      stderr: '',
    });
  });

  it('exits 2 and prints no result for each usage error', async () => {
    const folder = await writeSimulateFolder();
    const noScenarioFolder = await makeTemporaryFolder();
    await writeFile(join(folder, 'syntax.scenarios.js'), "export default [{ name: 'a' ,, }];\n");
    await writeFile(join(folder, 'unknown.scenarios.js'), "export default [{ name: 'a', expects: 'threw' }];\n");
    await writeFile(join(folder, 'twice.scenarios.js'), "export default [{ name: 'a' }, { name: 'a' }];\n");
    await writeFile(join(folder, 'throws.scenarios.js'), "export default [{ name: 'a', respond: () => { throw new Error('No answer written'); } }];\n");
    await writeFile(join(noScenarioFolder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(noScenarioFolder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'a.js' }] };\n");
    await writeFile(join(noScenarioFolder, 'missing-out.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'dist/a.js', scenarios: 's.js' }] };\n");
    await writeFile(join(noScenarioFolder, 'missing-scenarios.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'a.js', scenarios: 's.js' }] };\n");
    await writeFile(join(noScenarioFolder, 'a.js'), `${META}return 1;\n`);
    const cases = [
      [folder, ['simulate', ''], /^dwfb simulate: Name one workflow script\.\n\nUsage: dwfb simulate/],
      [folder, ['simulate', '--config', ''], /^dwfb simulate: Name the config file with --config <path>\.\n\nUsage: dwfb simulate/],
      [folder, ['simulate', 'answer.js'], /^dwfb simulate: No config file dwfb\.config\.js or dwfb\.config\.mjs exists here, so name the scenarios file with --scenarios <file>\.\n$/],
      [noScenarioFolder, ['simulate', 'b.js'], /^dwfb simulate: The config file dwfb\.config\.js has no workflow whose out is b\.js, so name the scenarios file with --scenarios <file>\.\n$/],
      [noScenarioFolder, ['simulate', 'a.js'], /^dwfb simulate: The workflow whose entry is a\.js has no scenarios, so name the scenarios file with --scenarios <file>\.\n$/],
      [folder, ['simulate', '--scenarios', 'answer.scenarios.js'], /^dwfb simulate: Name the script that --scenarios simulates\.\n\nUsage: dwfb simulate/],
      [folder, ['simulate', '--scenario', 'a'], /^dwfb simulate: Name the script that --scenario simulates\.\n\nUsage: dwfb simulate/],
      [folder, ['simulate', 'answer.js', '--scenarios', 'answer.scenarios.js', '--config', 'dwfb.config.js'], /^dwfb simulate: Name --scenarios or --config, not both, since a named scenarios file needs no config file\.\n\nUsage: dwfb simulate/],
      [folder, ['simulate', 'answer.js', 'clock.js', '--scenarios', 'answer.scenarios.js'], /^dwfb simulate: Name one workflow script\.\n/],
      [folder, ['simulate', 'answer.js', '--scenarios', ''], /^dwfb simulate: Name the scenarios file with --scenarios <file>\.\n/],
      [folder, ['simulate', 'answer.js', '--scenarios', 'answer.scenarios.js', '--verbose'], /^dwfb simulate: Unknown option '--verbose'[^]*\n\nUsage: dwfb simulate/],
      [folder, ['simulate', 'answer.js', '--scenarios', 'answer.scenarios.js', '--scenario', ''], /^dwfb simulate: Name the scenario with --scenario <name>\.\n/],
      [folder, ['simulate', 'answer.js', '--scenarios', 'answer.scenarios.js', '--scenario', 'other'], /^dwfb simulate: The scenarios file answer\.scenarios\.js holds no scenario named "other"\.\n$/],
      [folder, ['simulate', 'answer.js', '--scenarios', 'missing.js'], /^dwfb simulate: The scenarios file missing\.js does not exist\.\n$/],
      [folder, ['simulate', 'answer.js', '--scenarios', 'syntax.scenarios.js'], /^dwfb simulate: The scenarios file syntax\.scenarios\.js does not load\. syntax\.scenarios\.js:1:30 Unexpected token\.\n$/],
      [folder, ['simulate', 'answer.js', '--scenarios', 'unknown.scenarios.js'], /^dwfb simulate: Scenario 1 of the scenarios file unknown\.scenarios\.js has an unknown key expects\.\n$/],
      [folder, ['simulate', 'answer.js', '--scenarios', 'twice.scenarios.js'], /^dwfb simulate: Scenarios 1 and 2 of the scenarios file twice\.scenarios\.js are both named "a"\.\n$/],
      [
        folder,
        ['simulate', 'answer.js', '--scenarios', 'throws.scenarios.js'],
        /^dwfb simulate: The simulation of answer\.js with the scenario "a" of throws\.scenarios\.js cannot run\. The scenario's respond threw at call 0 \(label "answer"\)\. No answer written\.\n$/,
      ],
      [folder, ['simulate'], /^dwfb simulate: No config file dwfb\.config\.js or dwfb\.config\.mjs exists here, so name a script and --scenarios <file>, or name a config file with --config <path>\.\n$/],
      [noScenarioFolder, ['simulate'], /^dwfb simulate: The config file dwfb\.config\.js has no workflow with scenarios, so give a workflow scenarios, or name a script and --scenarios <file>\.\n$/],
      [noScenarioFolder, ['simulate', '--config', 'missing-out.config.js'], /^dwfb simulate: The out file dist\/a\.js of the workflow whose entry is a\.js does not exist, so run dwfb build a\.js --config missing-out\.config\.js\.\n$/],
      [noScenarioFolder, ['simulate', 'dist/a.js', '--config', 'missing-out.config.js'], /^dwfb simulate: The out file dist\/a\.js of the workflow whose entry is a\.js does not exist, so run dwfb build a\.js --config missing-out\.config\.js\.\n$/],
      [noScenarioFolder, ['simulate', '--config', 'missing-scenarios.config.js'], /^dwfb simulate: The scenarios of the workflow whose entry is a\.js cannot load\. The scenarios file s\.js does not exist\.\n$/],
      [noScenarioFolder, ['simulate', 'a.js', '--config', 'missing-scenarios.config.js'], /^dwfb simulate: The scenarios of the workflow whose entry is a\.js cannot load\. The scenarios file s\.js does not exist\.\n$/],
    ];

    for (const [cwd, args, message] of cases) {
      const { status, stdout, stderr } = runCommand(args, cwd);
      assert.deepEqual({ status, stdout }, { status: 2, stdout: '' }, args.join(' '));
      assert.match(stderr, message, args.join(' '));
    }
  });

  it('loads the example scenarios file of README.md, and its example script passes with it as the README shows', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const section = sliceMarkdownSection(readme, README_SIMULATE_HEADING);
    const exampleFiles = [...section.matchAll(README_FILE_PATTERN)].map((match) => match.groups);
    const run = README_RUN_PATTERN.exec(section)?.groups;
    const folder = await makeTemporaryFolder();

    assert.deepEqual(exampleFiles.map(({ path }) => path), ['.claude/workflows/review.js', 'workflows/review/scenarios.js']);
    assert.ok(run !== undefined, 'The README section on dwfb simulate shows no $ dwfb simulate command');
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    for (const { path, code } of exampleFiles) {
      await mkdir(join(folder, dirname(path)), { recursive: true });
      await writeFile(join(folder, path), code);
    }
    assert.deepEqual(runCommand(run.args.split(' '), folder), { status: 0, stdout: run.output, stderr: '' });
  });

  it('prints its usage for simulate --help, and the main usage lists it', () => {
    const { status, stdout } = runCommand(['simulate', '--help']);

    assert.equal(status, 0);
    assert.match(stdout, /^Usage: dwfb simulate \[<script>\] \[--scenarios <file>\] \[options\]\n[^]*\n {2}--scenario <name> {4}Run only the scenario of this name\.\n/);
    assert.match(runCommand(['--help']).stdout, /\n {2}simulate \[<script>\] \[--scenarios <file>\]\n {35}Run a workflow script/);
  });
});

describe('dwfb inspect', () => {
  const META = "export const meta = { name: 'p', description: 'd' };\n";
  const EVENTS_SCRIPT = [
    META,
    "phase('Plan');\n",
    "log('plans\\tstart\\nnow');\n",
    "await parallel([() => agent('Plan A', { label: 'plan' }), () => agent('Plan B\\n', { label: 'plan', phase: 'Side' })]);\n",
    "await pipeline(['x'], (item) => agent(`Draft ${item}`), () => agent('Check', { label: 'check', schema: { type: 'object' } }));\n",
    "return await agent('Judge', { label: 'judge', schema: { type: 'object' } });\n",
  ].join('');
  const EVENTS_SCENARIOS = [
    'export default [\n',
    "  { name: 'judged', respond: { plan: 'the plan', '': 'draft', check: null, judge: { verdict: 'pass' } } },\n",
    "  { name: 'no draft', respond: { plan: 'the plan' } },\n",
    '];\n',
  ].join('');
  const NO_DRAFT_MESSAGE = "No key of respond matches call 2 (no label). Add the key '', which matches a call with no label";
  const PLAN_CALL_LINES = [
    'call 0 (label "plan"): phase "Plan", parallel 0 item 0, prompt of 6 characters, returned a string of 8 characters.\n',
    'call 1 (label "plan"): phase "Side", parallel 0 item 1, prompt of 7 characters, returned a string of 8 characters.\n',
  ].join('');
  const EVENT_HEAD_LINES = 'phase "Plan"\nlog plans\\u{0009}start\\u{000A}now\n';
  const CLOCK_FINDING = 'clock.js:2:8 clock-unavailable The script uses Date.now, which throws in the runtime when called. Pass the time through args, or stamp the result after the workflow returns.';
  const README_SECTION_HEADING = '\n## dwfb inspect\n';
  const README_RUN_PATTERN = /^\$ dwfb (?<args>inspect [^\n]*)\n(?<output>[^]*?)```$/gm;
  const ARGUMENT_PATTERN = /"(?<quoted>[^"]*)"|(?<bare>\S+)/g;

  /**
   * @returns {Promise<string>} A new folder of an ES module package that holds the scripts and the scenarios
   *   files of these tests.
   */
  async function writeInspectFolder() {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(folder, 'events.js'), EVENTS_SCRIPT);
    await writeFile(join(folder, 'events.scenarios.js'), EVENTS_SCENARIOS);
    await writeFile(join(folder, 'answer.js'), `${META}const answer = await agent('Answer', { label: 'answer' });\nif (answer === null) throw new TypeError('The answer agent died');\nreturn answer;\n`);
    await writeFile(join(folder, 'answer.scenarios.js'), "export default [{ name: 'answer died', respond: { answer: null } }];\n");
    await writeFile(join(folder, 'clock.js'), `${META}return Date.now();\n`);
    return folder;
  }

  it('prints how the simulation ended with no FAILED mark, then one line per event in the order the script made them', async () => {
    const folder = await writeInspectFolder();

    assert.deepEqual(runCommand(['inspect', 'events.js', '--scenarios', 'events.scenarios.js', '--scenario', 'judged'], folder), {
      status: 0,
      stdout: [
        'events.js judged: returned, 5 calls.\n',
        EVENT_HEAD_LINES,
        PLAN_CALL_LINES,
        'call 2 (no label): phase "Plan", pipeline 1 item 0 stage 0, prompt of 7 characters, returned a string of 5 characters.\n',
        'call 3 (label "check"): phase "Plan", pipeline 1 item 0 stage 1, prompt of 5 characters, returned null.\n',
        'call 4 (label "judge"): phase "Plan", prompt of 5 characters, returned an object.\n',
      ].join(''),
      stderr: '',
    });
  });

  it('prints no return for the call a simulation stopped at, and exits 0', async () => {
    const folder = await writeInspectFolder();

    assert.deepEqual(runCommand(['inspect', 'events.js', '--scenarios', 'events.scenarios.js', '--scenario', 'no draft'], folder), {
      status: 0,
      stdout: [
        `events.js no draft: stopped at call 2 (no label): ${NO_DRAFT_MESSAGE}, 3 calls.\n`,
        EVENT_HEAD_LINES,
        PLAN_CALL_LINES,
        'call 2 (no label): phase "Plan", pipeline 1 item 0 stage 0, prompt of 7 characters, no return.\n',
      ].join(''),
      stderr: '',
    });
  });

  it('prints one call in full with --call, and adds a line end only to a prompt or a string return that ends with none', async () => {
    const folder = await writeInspectFolder();
    const args = ['inspect', 'events.js', '--scenarios', 'events.scenarios.js', '--scenario', 'judged', '--call'];

    assert.deepEqual(runCommand([...args, '0'], folder), {
      status: 0,
      stdout: 'call 0 (label "plan") of events.js judged\nphase: "Plan"\ngroup: parallel 0, item 0 of 2\noptions:\n{\n  "label": "plan"\n}\nprompt of 6 characters:\nPlan A\nreturned a string of 8 characters:\nthe plan\n',
      stderr: '',
    });
    assert.deepEqual(runCommand([...args, '1'], folder), {
      status: 0,
      stdout: 'call 1 (label "plan") of events.js judged\nphase: "Side"\ngroup: parallel 0, item 1 of 2\noptions:\n{\n  "label": "plan",\n  "phase": "Side"\n}\nprompt of 7 characters:\nPlan B\nreturned a string of 8 characters:\nthe plan\n',
      stderr: '',
    });
    assert.deepEqual(runCommand([...args, '3'], folder), {
      status: 0,
      stdout: 'call 3 (label "check") of events.js judged\nphase: "Plan"\ngroup: pipeline 1, item 0 of 1, stage 1 of 2\noptions:\n{\n  "label": "check",\n  "schema": {\n    "type": "object"\n  }\n}\nprompt of 5 characters:\nCheck\nreturned: null, an agent that died\n',
      stderr: '',
    });
    assert.deepEqual(runCommand([...args, '4'], folder), {
      status: 0,
      stdout: 'call 4 (label "judge") of events.js judged\nphase: "Plan"\ngroup: none\noptions:\n{\n  "label": "judge",\n  "schema": {\n    "type": "object"\n  }\n}\nprompt of 5 characters:\nJudge\nreturned:\n{\n  "verdict": "pass"\n}\n',
      stderr: '',
    });
  });

  it('prints an empty prompt or string return apart from one of a line end, with --call', async () => {
    const folder = await writeInspectFolder();
    await writeFile(join(folder, 'ends.js'), `${META}await agent('', { label: 'empty' });\nawait agent('\\n', { label: 'line end' });\nreturn 'done';\n`);
    await writeFile(join(folder, 'ends.scenarios.js'), "export default [{ name: 'ends', respond: { empty: '', 'line end': '\\n' } }];\n");
    const args = ['inspect', 'ends.js', '--scenarios', 'ends.scenarios.js', '--call'];
    const empty = runCommand([...args, '0'], folder);
    const lineEnd = runCommand([...args, '1'], folder);

    assert.deepEqual(empty, {
      status: 0,
      stdout: 'call 0 (label "empty") of ends.js ends\nphase: none\ngroup: none\noptions:\n{\n  "label": "empty"\n}\nprompt of 0 characters:\n\nreturned a string of 0 characters:\n\n',
      stderr: '',
    });
    assert.deepEqual(lineEnd, {
      status: 0,
      stdout: 'call 1 (label "line end") of ends.js ends\nphase: none\ngroup: none\noptions:\n{\n  "label": "line end"\n}\nprompt of 1 character:\n\nreturned a string of 1 character:\n\n',
      stderr: '',
    });
    assert.notEqual(empty.stdout.slice(empty.stdout.indexOf('prompt')), lineEnd.stdout.slice(lineEnd.stdout.indexOf('prompt')));
  });

  it('prints a call made after the script settled that got no scripted return as no return, in the events and in full', async () => {
    const folder = await writeInspectFolder();
    await writeFile(join(folder, 'late.js'), `${META}Promise.resolve().then(() => agent('Late', { label: 'late' }));\nreturn 'done';\n`);
    const args = ['inspect', 'late.js', '--scenarios', 'answer.scenarios.js'];

    assert.deepEqual(runCommand(args, folder), {
      status: 0,
      stdout: 'late.js answer died: returned, 1 call.\ncall 0 (label "late"): prompt of 4 characters, no return.\n',
      stderr: '',
    });
    assert.deepEqual(runCommand([...args, '--call', '0'], folder), {
      status: 0,
      stdout: 'call 0 (label "late") of late.js answer died\nphase: none\ngroup: none\noptions:\n{\n  "label": "late"\n}\nprompt of 4 characters:\nLate\nno return, since the script had settled and the scenario holds no usable scripted return for this call\n',
      stderr: '',
    });
  });

  it('prints a call made after the script settled past the cap as no return, with --call', async () => {
    const folder = await writeInspectFolder();
    await writeFile(join(folder, 'cap.js'), `${META}for (let index = 0; index < 1000; index += 1) await agent('x');\nPromise.resolve().then(() => agent('Late', { label: 'late' }));\nreturn 'done';\n`);
    await writeFile(join(folder, 'cap.scenarios.js'), "export default [{ name: 'cap', respond: { '': 'any' } }];\n");

    assert.deepEqual(runCommand(['inspect', 'cap.js', '--scenarios', 'cap.scenarios.js', '--call', '1000'], folder), {
      status: 0,
      stdout: 'call 1000 (label "late") of cap.js cap\nphase: none\ngroup: none\noptions:\n{\n  "label": "late"\n}\nprompt of 4 characters:\nLate\nno return, since the script had settled and the call came after the cap of 1000 agent() calls\n',
      stderr: '',
    });
  });

  it('prints the stop in place of the return for the call a simulation stopped at, and the options line of a call with none', async () => {
    const folder = await writeInspectFolder();

    assert.deepEqual(runCommand(['inspect', 'events.js', '--scenarios', 'events.scenarios.js', '--scenario', 'no draft', '--call', '2'], folder), {
      status: 0,
      stdout: `call 2 (no label) of events.js no draft\nphase: "Plan"\ngroup: pipeline 1, item 0 of 1, stage 0 of 2\noptions: none, or options that JSON cannot hold\nprompt of 7 characters:\nDraft x\nstopped: ${NO_DRAFT_MESSAGE}\n`,
      stderr: '',
    });
  });

  it('prints that options line also for a call whose options JSON cannot hold', async () => {
    const folder = await writeInspectFolder();
    await writeFile(join(folder, 'big.js'), `${META}return await agent('A', { label: 'a', count: 1n });\n`);
    await writeFile(join(folder, 'big.scenarios.js'), "export default [{ name: 'big', respond: { a: 'y' } }];\n");

    assert.deepEqual(runCommand(['inspect', 'big.js', '--scenarios', 'big.scenarios.js', '--call', '0'], folder), {
      status: 0,
      stdout: 'call 0 (label "a") of big.js big\nphase: none\ngroup: none\noptions: none, or options that JSON cannot hold\nprompt of 1 character:\nA\nreturned a string of 1 character:\ny\n',
      stderr: '',
    });
  });

  it('takes the one scenario of a scenarios file with no --scenario, and exits 0 for a simulation that threw', async () => {
    const folder = await writeInspectFolder();

    assert.deepEqual(runCommand(['inspect', 'answer.js', '--scenarios', 'answer.scenarios.js'], folder), {
      status: 0,
      stdout: 'answer.js answer died: threw TypeError: The answer agent died, 1 call.\ncall 0 (label "answer"): prompt of 6 characters, returned null.\n',
      stderr: '',
    });
  });

  it('counts 1 character in the singular, for a prompt and for a string return', async () => {
    const folder = await writeInspectFolder();
    await writeFile(join(folder, 'one.js'), `${META}return await agent('A');\n`);
    await writeFile(join(folder, 'one.scenarios.js'), "export default [{ name: 'one', respond: { '': 'y' } }];\n");

    assert.deepEqual(runCommand(['inspect', 'one.js', '--scenarios', 'one.scenarios.js'], folder), {
      status: 0,
      stdout: 'one.js one: returned, 1 call.\ncall 0 (no label): prompt of 1 character, returned a string of 1 character.\n',
      stderr: '',
    });
  });

  it('prints one JSON object with --json, for the events and for one call', async () => {
    const folder = await writeInspectFolder();
    const args = ['inspect', 'answer.js', '--scenarios', 'answer.scenarios.js', '--json'];
    const head = { ok: true, script: 'answer.js', scenario: 'answer died', runtime: '2.1.332', end: { kind: 'threw', name: 'TypeError', message: 'The answer agent died', frames: [{ line: 3, column: 28 }] }, callCount: 1 };
    const events = runCommand(args, folder);
    const call = runCommand([...args, '--call', '0'], folder);

    assert.deepEqual({ status: events.status, stderr: events.stderr }, { status: 0, stderr: '' });
    assert.deepEqual(JSON.parse(events.stdout), {
      ...head,
      events: [{ kind: 'call', index: 0, label: 'answer', phase: null, group: null, promptLength: 6, returnedType: 'null', returnedLength: null }],
    });
    assert.deepEqual({ status: call.status, stderr: call.stderr }, { status: 0, stderr: '' });
    assert.deepEqual(JSON.parse(call.stdout), {
      ...head,
      call: { index: 0, label: 'answer', phase: null, group: null, opts: { label: 'answer' }, prompt: 'Answer', returned: null },
    });
  });

  it('prints the findings of a refused script and how it ended, with or without --call, and exits 1', async () => {
    const folder = await writeInspectFolder();
    const args = ['inspect', 'clock.js', '--scenarios', 'answer.scenarios.js'];
    const expected = { status: 1, stdout: `${CLOCK_FINDING}\nclock.js answer died: refused, 0 calls.\n`, stderr: '' };
    const json = runCommand([...args, '--json'], folder);

    assert.deepEqual(runCommand(args, folder), expected);
    assert.deepEqual(runCommand([...args, '--call', '0'], folder), expected);
    assert.deepEqual({ status: json.status, stderr: json.stderr }, { status: 1, stderr: '' });
    assert.equal(JSON.parse(json.stdout).ok, false);
    assert.deepEqual(JSON.parse(json.stdout).events, []);
  });

  it('names how a simulation that stopped before its first call ended in the usage error for --call, and exits 2', async () => {
    const folder = await writeInspectFolder();
    await writeFile(join(folder, 'waits.js'), `${META}await new Promise(() => {});\n`);
    const message = 'The script waits on a promise that nothing settles. A run of this script would not end';

    assert.deepEqual(runCommand(['inspect', 'waits.js', '--scenarios', 'answer.scenarios.js', '--call', '0'], folder), {
      status: 2,
      stdout: '',
      stderr: `dwfb inspect: The simulation made no call, and it ended as stopped: ${message}.\n`,
    });
  });

  it('names how a simulation that returned with no call ended in the usage error for --call, and exits 2', async () => {
    const folder = await writeInspectFolder();
    await writeFile(join(folder, 'none.js'), `${META}return 1;\n`);

    assert.deepEqual(runCommand(['inspect', 'none.js', '--scenarios', 'answer.scenarios.js', '--call', '0', '--json'], folder), {
      status: 2,
      stdout: '',
      stderr: 'dwfb inspect: The simulation made no call, and it ended as returned.\n',
    });
  });

  it('reads the scenarios file of the config workflow whose out is the script when no --scenarios names one', async () => {
    const folder = await writeInspectFolder();
    const config = "export default { workflows: [{ entry: 'answer.js', out: 'dist/answer.js', scenarios: 'answer.scenarios.js' }] };\n";
    const expected = { status: 0, stdout: 'dist/answer.js answer died: threw TypeError: The answer agent died, 1 call.\ncall 0 (label "answer"): prompt of 6 characters, returned null.\n', stderr: '' };
    await mkdir(join(folder, 'dist'));
    await cp(join(folder, 'answer.js'), join(folder, 'dist', 'answer.js'));
    await writeFile(join(folder, 'dwfb.config.js'), config);
    await writeFile(join(folder, 'other.config.js'), config);

    assert.deepEqual(runCommand(['inspect', 'dist/answer.js'], folder), expected);
    await rm(join(folder, 'dwfb.config.js'));
    assert.deepEqual(runCommand(['inspect', 'dist/answer.js', '--config', 'other.config.js'], folder), expected);
  });

  it('exits 2 and prints no result for each usage error', async () => {
    const folder = await writeInspectFolder();
    const configFolder = await makeTemporaryFolder();
    await writeFile(join(configFolder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(configFolder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'a.js' }] };\n");
    await writeFile(join(configFolder, 'missing-out.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'dist/a.js', scenarios: 's.js' }] };\n");
    await writeFile(join(configFolder, 'a.js'), `${META}return 1;\n`);
    await writeFile(join(folder, 'tab.scenarios.js'), "export default [{ name: 'a\\tb' }, { name: 'c' }];\n");
    const scenariosArgs = ['inspect', 'events.js', '--scenarios', 'events.scenarios.js'];
    const cases = [
      [folder, ['inspect'], /^dwfb inspect: Name one workflow script\.\n\nUsage: dwfb inspect/],
      [folder, ['inspect', ''], /^dwfb inspect: Name one workflow script\.\n\nUsage: dwfb inspect/],
      [folder, ['inspect', 'events.js', 'answer.js'], /^dwfb inspect: Name one workflow script\.\n\nUsage: dwfb inspect/],
      [folder, ['inspect', 'events.js', '--verbose'], /^dwfb inspect: Unknown option '--verbose'[^]*\n\nUsage: dwfb inspect/],
      [folder, ['inspect', 'events.js', '--scenarios', ''], /^dwfb inspect: Name the scenarios file with --scenarios <file>\.\n\nUsage: dwfb inspect/],
      [folder, [...scenariosArgs, '--scenario', ''], /^dwfb inspect: Name the scenario with --scenario <name>\.\n\nUsage: dwfb inspect/],
      [folder, [...scenariosArgs, '--call', ''], /^dwfb inspect: Name the call with --call <index>\.\n\nUsage: dwfb inspect/],
      [folder, ['inspect', 'events.js', '--config', ''], /^dwfb inspect: Name the config file with --config <path>\.\n\nUsage: dwfb inspect/],
      [folder, [...scenariosArgs, '--scenario', 'judged', '--call', '1.5'], /^dwfb inspect: The call "1\.5" is not a whole number written in digits\.\n\nUsage: dwfb inspect/],
      [folder, [...scenariosArgs, '--scenario', 'judged', '--call=-1'], /^dwfb inspect: The call "-1" is not a whole number written in digits\.\n\nUsage: dwfb inspect/],
      [folder, [...scenariosArgs, '--scenario', 'judged', '--call', '1\t'], /^dwfb inspect: The call "1\\u\{0009\}" is not a whole number written in digits\.\n\nUsage: dwfb inspect/],
      [folder, [...scenariosArgs, '--scenario', 'judged', '--call', '5'], /^dwfb inspect: The simulation made 5 calls, so name a call from 0 to 4\.\n$/],
      [folder, [...scenariosArgs, '--config', 'dwfb.config.js'], /^dwfb inspect: Name --scenarios or --config, not both, since a named scenarios file needs no config file\.\n\nUsage: dwfb inspect/],
      [folder, ['inspect', 'events.js'], /^dwfb inspect: No config file dwfb\.config\.js or dwfb\.config\.mjs exists here, so name the scenarios file with --scenarios <file>\.\n$/],
      [configFolder, ['inspect', 'b.js'], /^dwfb inspect: The config file dwfb\.config\.js has no workflow whose out is b\.js, so name the scenarios file with --scenarios <file>\.\n$/],
      [configFolder, ['inspect', 'a.js'], /^dwfb inspect: The workflow whose entry is a\.js has no scenarios, so name the scenarios file with --scenarios <file>\.\n$/],
      [configFolder, ['inspect', 'dist/a.js', '--config', 'missing-out.config.js'], /^dwfb inspect: The out file dist\/a\.js of the workflow whose entry is a\.js does not exist, so run dwfb build a\.js --config missing-out\.config\.js\.\n$/],
      [folder, scenariosArgs, /^dwfb inspect: The scenarios file events\.scenarios\.js holds 2 scenarios, so name one with --scenario <name>: "judged", "no draft"\.\n$/],
      [folder, ['inspect', 'events.js', '--scenarios', 'tab.scenarios.js'], /^dwfb inspect: The scenarios file tab\.scenarios\.js holds 2 scenarios, so name one with --scenario <name>: "a\\u\{0009\}b", "c"\.\n$/],
      [folder, [...scenariosArgs, '--scenario', 'other'], /^dwfb inspect: The scenarios file events\.scenarios\.js holds no scenario named "other"\.\n$/],
    ];

    for (const [cwd, args, message] of cases) {
      const { status, stdout, stderr } = runCommand(args, cwd);
      assert.deepEqual({ status, stdout }, { status: 2, stdout: '' }, args.join(' '));
      assert.match(stderr, message, args.join(' '));
    }
  });

  it('prints what each example of the README section on dwfb inspect shows, for the example files of dwfb simulate', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const exampleFiles = [...sliceMarkdownSection(readme, README_SIMULATE_HEADING).matchAll(README_FILE_PATTERN)].map((match) => match.groups);
    const runs = [...sliceMarkdownSection(readme, README_SECTION_HEADING).matchAll(README_RUN_PATTERN)].map((match) => match.groups);
    const folder = await makeTemporaryFolder();

    assert.equal(runs.length, 2, 'The README section on dwfb inspect shows an example of the events and one of a call');
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    for (const { path, code } of exampleFiles) {
      await mkdir(join(folder, dirname(path)), { recursive: true });
      await writeFile(join(folder, path), code);
    }
    for (const { args, output } of runs) {
      const commandArgs = [...args.matchAll(ARGUMENT_PATTERN)].map(({ groups }) => groups.quoted ?? groups.bare);
      assert.deepEqual(runCommand(commandArgs, folder), { status: 0, stdout: output, stderr: '' }, args);
    }
  });

  it('prints its usage for inspect --help, and the main usage lists it', () => {
    const { status, stdout } = runCommand(['inspect', '--help']);

    assert.equal(status, 0);
    assert.match(stdout, /^Usage: dwfb inspect <script> \[--scenarios <file>\] \[--scenario <name>\] \[--call <index>\] \[options\]\n[^]*\n {2}--call <index> {7}Print the call of this index in full\. The first call is 0\.\n/);
    assert.match(runCommand(['--help']).stdout, /\n {2}inspect <script> \[--scenarios <file>\] \[--scenario <name>\] \[--call <index>\]\n {35}Run a workflow script against one scenario/);
  });
});

describe('dwfb map', () => {
  const FLOW_SCRIPT = [
    "export const meta = { name: 'flow', description: 'd' };\n",
    "await agent('Work.', { label: 'work' });\n",
    "if (args?.fail) throw new Error('The work failed');\n",
    "return { status: 'done' };\n",
  ].join('');
  const FLOW_SCENARIOS = "export default [{ name: 'works', respond: { work: 'ok' } }, { name: 'fails', expect: 'threw', args: { fail: true }, respond: { work: 'ok' } }];\n";
  const GAP_SCRIPT = "export const meta = { name: 'gap', description: 'd' };\nawait agent('Work.', { label: 'work' });\nreturn {};\n";
  const GAP_SCENARIOS = "export default [{ name: 'no\\tstatus', respond: { work: 'ok' } }];\n";
  const GAP_LINE = 'gap.js no\\u{0009}status: not mapped, since the script returned no status that is a non-empty string, and the scenario names no endState.\n';
  const CONFIG = [
    'export default { workflows: [\n',
    "  { entry: 'gap.entry.js', out: 'gap.js', scenarios: 'gap.scenarios.js', map: 'maps/gap.flow-map.md' },\n",
    "  { entry: 'plain.entry.js', out: 'plain.js', scenarios: 'flow.scenarios.js' },\n",
    "  { entry: 'flow.entry.js', out: 'flow.js', scenarios: 'flow.scenarios.js', map: 'maps/flow.flow-map.md' },\n",
    '] };\n',
  ].join('');
  const README_SECTION_HEADING = '\n## dwfb map\n';
  const README_RUN_PATTERN = /^\$ dwfb (?<args>map [^\n]*)\n(?<output>[^]*?)```$/m;
  const README_MAP_FILE_PATTERN = /^`(?<path>[^`\n]+)`:\n\n````markdown\n(?<text>[^]*?)````$/m;
  const FLOW_SCENARIOS_ARGS = ['--scenarios', 'flow.scenarios.js'];
  const CLOCK_SCRIPT = "export const meta = { name: 'clock', description: 'd' };\nreturn Date.now();\n";

  /**
   * @returns {Promise<string>} A new folder of an ES module package that holds the scripts, the scenarios files
   *   and the config file of these tests.
   */
  async function writeMapFolder() {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(folder, 'dwfb.config.js'), CONFIG);
    await writeFile(join(folder, 'flow.js'), FLOW_SCRIPT);
    await writeFile(join(folder, 'plain.js'), FLOW_SCRIPT);
    await writeFile(join(folder, 'flow.scenarios.js'), FLOW_SCENARIOS);
    await writeFile(join(folder, 'gap.js'), GAP_SCRIPT);
    await writeFile(join(folder, 'gap.scenarios.js'), GAP_SCENARIOS);
    return folder;
  }

  /**
   * @param {string} folder
   * @returns {Promise<string>} The flow map that the library gives for flow.js and its scenarios file.
   */
  async function formatExpectedFlowMap(folder) {
    const { graph } = await mapLibrary({ script: join(folder, 'flow.js'), scenarios: join(folder, 'flow.scenarios.js') });
    return formatFlowMap('flow', /** @type {import('../src/build-flow-graph.js').FlowGraph} */ (graph));
  }

  it('prints the flow map of a script and the scenarios file --scenarios names, and writes no file', async () => {
    const folder = await writeMapFolder();

    assert.deepEqual(runCommand(['map', 'flow.js', ...FLOW_SCENARIOS_ARGS], folder), { status: 0, stdout: await formatExpectedFlowMap(folder), stderr: '' });
    assert.equal((await readdir(folder)).includes('maps'), false);
  });

  it('prints the flow map of a script whose config workflow has no map, from the scenarios of that workflow', async () => {
    const folder = await writeMapFolder();

    assert.deepEqual(runCommand(['map', 'plain.js'], folder), { status: 0, stdout: await formatExpectedFlowMap(folder), stderr: '' });
  });

  it('writes the file --out names, creating its folder, and then leaves the file unchanged when its bytes would not change', async () => {
    const folder = await writeMapFolder();
    const file = join(folder, 'docs', 'deep', 'flow.md');
    const oldTime = new Date('2001-01-01T00:00:00Z');

    assert.deepEqual(runCommand(['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', 'docs/deep/flow.md'], folder), { status: 0, stdout: 'Wrote docs/deep/flow.md.\n', stderr: '' });
    assert.equal(await readFile(file, 'utf8'), await formatExpectedFlowMap(folder));
    await utimes(file, oldTime, oldTime);
    assert.deepEqual(runCommand(['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', 'docs/deep/flow.md'], folder), { status: 0, stdout: 'Unchanged docs/deep/flow.md.\n', stderr: '' });
    assert.equal((await stat(file)).mtimeMs, oldTime.getTime());
    await writeFile(file, 'old');
    assert.deepEqual(runCommand(['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', 'docs/deep/flow.md'], folder), { status: 0, stdout: 'Wrote docs/deep/flow.md.\n', stderr: '' });
    assert.equal(await readFile(file, 'utf8'), await formatExpectedFlowMap(folder));
  });

  it('writes the map of the config workflow whose out is the script, and with no script the map of each workflow that has one', async () => {
    const folder = await writeMapFolder();
    const flowMap = await formatExpectedFlowMap(folder);

    assert.deepEqual(runCommand(['map', 'flow.js'], folder), { status: 0, stdout: 'Wrote maps/flow.flow-map.md.\n', stderr: '' });
    assert.equal(await readFile(join(folder, 'maps', 'flow.flow-map.md'), 'utf8'), flowMap);
    await writeFile(join(folder, 'gap.scenarios.js'), FLOW_SCENARIOS);
    await writeFile(join(folder, 'gap.js'), FLOW_SCRIPT);
    assert.deepEqual(runCommand(['map'], folder), { status: 0, stdout: 'Wrote maps/gap.flow-map.md.\nUnchanged maps/flow.flow-map.md.\n', stderr: '' });
    assert.equal(await readFile(join(folder, 'maps', 'gap.flow-map.md'), 'utf8'), flowMap);
  });

  it('prints one line per unmapped scenario, writes no file for its script, still maps the other workflows and exits 1', async () => {
    const folder = await writeMapFolder();

    assert.deepEqual(runCommand(['map'], folder), { status: 1, stdout: `${GAP_LINE}Wrote maps/flow.flow-map.md.\n`, stderr: '' });
    assert.deepEqual(await readdir(join(folder, 'maps')), ['flow.flow-map.md']);
    assert.deepEqual(runCommand(['map', 'gap.js', '--scenarios', 'gap.scenarios.js'], folder), { status: 1, stdout: GAP_LINE, stderr: '' });
  });

  it('prints the findings of a refused script before its unmapped scenarios', async () => {
    const folder = await writeMapFolder();
    await writeFile(join(folder, 'clock.js'), CLOCK_SCRIPT);

    assert.deepEqual(runCommand(['map', 'clock.js', ...FLOW_SCENARIOS_ARGS], folder), {
      status: 1,
      stdout: [
        'clock.js:2:8 clock-unavailable The script uses Date.now, which throws in the runtime when called. Pass the time through args, or stamp the result after the workflow returns.\n',
        'clock.js works: not mapped, since refused.\n',
        'clock.js fails: not mapped, since refused.\n',
      ].join(''),
      stderr: '',
    });
  });

  it('reports each file as fresh or stale with --check, writes nothing, and exits 1 for a stale file', async () => {
    const folder = await writeMapFolder();
    const file = join(folder, 'maps', 'flow.flow-map.md');

    assert.deepEqual(runCommand(['map', 'flow.js', '--check'], folder), { status: 1, stdout: 'Stale maps/flow.flow-map.md: the file is missing.\n', stderr: '' });
    assert.equal((await readdir(folder)).includes('maps'), false);
    await mkdir(join(folder, 'maps'));
    await writeFile(file, 'old');
    assert.deepEqual(runCommand(['map', 'flow.js', '--check'], folder), { status: 1, stdout: 'Stale maps/flow.flow-map.md: the file differs from the flow map of flow.js.\n', stderr: '' });
    assert.equal(await readFile(file, 'utf8'), 'old');
    await writeFile(file, await formatExpectedFlowMap(folder));
    assert.deepEqual(runCommand(['map', 'flow.js', '--check'], folder), { status: 0, stdout: 'Fresh maps/flow.flow-map.md.\n', stderr: '' });
    assert.deepEqual(runCommand(['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', 'maps/flow.flow-map.md', '--check'], folder), { status: 0, stdout: 'Fresh maps/flow.flow-map.md.\n', stderr: '' });
    assert.deepEqual(runCommand(['map', '--check'], folder), { status: 1, stdout: `${GAP_LINE}Fresh maps/flow.flow-map.md.\n`, stderr: '' });
  });

  it('prints one JSON object with the result of map() for each script, writes no file, and exits 1 for an unmapped scenario', async () => {
    const folder = await writeMapFolder();
    const flowResult = await mapLibrary({ script: join(folder, 'flow.js'), scenarios: join(folder, 'flow.scenarios.js') });
    const configRun = runCommand(['map', '--json'], folder);
    const scriptRun = runCommand(['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--json'], folder);

    assert.equal(configRun.status, 1);
    assert.deepEqual(JSON.parse(configRun.stdout), {
      ok: false,
      runtime: CONTRACT_RUNTIME_VERSION,
      maps: [
        { script: 'gap.js', file: 'maps/gap.flow-map.md', check: null, ok: false, runtime: CONTRACT_RUNTIME_VERSION, graph: null, unmapped: [{ scenario: 'no\tstatus', reason: 'the script returned no status that is a non-empty string, and the scenario names no endState' }], findings: [] },
        { script: 'flow.js', file: 'maps/flow.flow-map.md', check: null, ok: true, runtime: CONTRACT_RUNTIME_VERSION, graph: flowResult.graph, unmapped: [], findings: [] },
      ],
    });
    assert.deepEqual({ status: scriptRun.status, stderr: scriptRun.stderr }, { status: 0, stderr: '' });
    assert.deepEqual(JSON.parse(scriptRun.stdout).maps.map(({ script, file, ok }) => ({ script, file, ok })), [{ script: 'flow.js', file: null, ok: true }]);
    await writeFile(join(folder, 'clock.js'), CLOCK_SCRIPT);
    const refusedRun = runCommand(['map', 'clock.js', ...FLOW_SCENARIOS_ARGS, '--json'], folder);
    assert.equal(refusedRun.status, 1);
    assert.deepEqual(JSON.parse(refusedRun.stdout).maps[0].findings.map(({ rule, line, column }) => ({ rule, line, column })), [{ rule: 'clock-unavailable', line: 2, column: 8 }]);
    assert.equal((await readdir(folder)).includes('maps'), false);
  });

  it('gives each map of the JSON object the check of its file with --check, writes nothing, and exits 1 for a stale or missing file', async () => {
    const folder = await writeMapFolder();
    const file = join(folder, 'maps', 'flow.flow-map.md');
    const flowResult = await mapLibrary({ script: join(folder, 'flow.js'), scenarios: join(folder, 'flow.scenarios.js') });
    /** @param {string[]} args */
    const runCheck = (args) => {
      const { status, stdout, stderr } = runCommand(args, folder);
      const { ok, maps } = JSON.parse(stdout);
      return { status, stderr, ok, checks: maps.map(({ script, file: mapFile, check }) => ({ script, file: mapFile, check })) };
    };
    const missingRun = runCheck(['map', 'flow.js', '--check', '--json']);

    assert.deepEqual(missingRun, { status: 1, stderr: '', ok: false, checks: [{ script: 'flow.js', file: 'maps/flow.flow-map.md', check: 'missing' }] });
    assert.equal((await readdir(folder)).includes('maps'), false);
    await mkdir(join(folder, 'maps'));
    await writeFile(file, 'old');
    assert.deepEqual(runCheck(['map', 'flow.js', '--check', '--json']), { status: 1, stderr: '', ok: false, checks: [{ script: 'flow.js', file: 'maps/flow.flow-map.md', check: 'stale' }] });
    assert.equal(await readFile(file, 'utf8'), 'old');
    await writeFile(file, await formatExpectedFlowMap(folder));
    assert.deepEqual(runCheck(['map', 'flow.js', '--check', '--json']), { status: 0, stderr: '', ok: true, checks: [{ script: 'flow.js', file: 'maps/flow.flow-map.md', check: 'fresh' }] });
    assert.deepEqual(JSON.parse(runCommand(['map', 'flow.js', '--check', '--json'], folder).stdout).maps[0].graph, flowResult.graph);
    assert.deepEqual(runCheck(['map', '--check', '--json']), {
      status: 1,
      stderr: '',
      ok: false,
      checks: [
        { script: 'gap.js', file: 'maps/gap.flow-map.md', check: null },
        { script: 'flow.js', file: 'maps/flow.flow-map.md', check: 'fresh' },
      ],
    });
    assert.deepEqual(await readdir(join(folder, 'maps')), ['flow.flow-map.md']);
  });

  it('refuses a flow map file that names the config file the command read, by any spelling, and keeps its bytes', async () => {
    const folder = await writeMapFolder();
    const configText = CONFIG.replace('maps/flow.flow-map.md', 'dwfb.config.js');
    const linkConfigText = "export default { workflows: [{ entry: '../flow.entry.js', out: '../flow.js', scenarios: '../flow.scenarios.js', map: '../linked/dwfb.config.js' }] };\n";
    await mkdir(join(folder, 'conf'));
    await symlink(join(folder, 'conf'), join(folder, 'linked'), 'junction');
    await writeFile(join(folder, 'conf', 'dwfb.config.js'), linkConfigText);
    const cases = [
      [['map', 'flow.js', '--out', 'dwfb.config.js'], 'dwfb map: The flow map file dwfb.config.js names the config file dwfb.config.js, which the write would replace.\n'],
      [['map', 'flow.js', '--out', 'dwfb.config.js', '--check', '--json'], 'dwfb map: The flow map file dwfb.config.js names the config file dwfb.config.js, which the write would replace.\n'],
      [['map', '--config', 'conf/dwfb.config.js'], 'dwfb map: The flow map file linked/dwfb.config.js names the config file conf/dwfb.config.js, which the write would replace.\n'],
      [['map', 'flow.js', '--config', 'conf/dwfb.config.js', '--out', 'linked/dwfb.config.js'], 'dwfb map: The flow map file linked/dwfb.config.js names the config file conf/dwfb.config.js, which the write would replace.\n'],
    ];

    for (const [args, stderr] of cases) assert.deepEqual(runCommand(args, folder), { status: 2, stdout: '', stderr }, args.join(' '));
    // A named scenarios file reads no config file, so the command checks none.
    assert.deepEqual(runCommand(['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', 'conf/dwfb.config.js'], folder), { status: 0, stdout: 'Wrote conf/dwfb.config.js.\n', stderr: '' });
    await writeFile(join(folder, 'conf', 'dwfb.config.js'), linkConfigText);
    await writeFile(join(folder, 'dwfb.config.js'), configText);
    assert.deepEqual(runCommand(['map'], folder), { status: 2, stdout: '', stderr: 'dwfb map: Workflow 3 of the config file dwfb.config.js writes the map dwfb.config.js, which names the config file.\n' });
    assert.equal(await readFile(join(folder, 'dwfb.config.js'), 'utf8'), configText);
    assert.equal(await readFile(join(folder, 'conf', 'dwfb.config.js'), 'utf8'), linkConfigText);
    assert.equal((await readdir(folder)).includes('maps'), false);
  });

  it('prints each usage error to stderr and exits 2', async () => {
    const folder = await writeMapFolder();
    const emptyFolder = await makeTemporaryFolder();
    await writeFile(join(emptyFolder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(emptyFolder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'a.out.js' }] };\n");
    const cases = [
      [folder, ['map', 'flow.js', 'gap.js'], /^dwfb map: Name one workflow script\.\n\nUsage: dwfb map /],
      [folder, ['map', ''], /^dwfb map: Name one workflow script\.\n/],
      [folder, ['map', 'flow.js', '--scenarios', ''], /^dwfb map: Name the scenarios file with --scenarios <file>\.\n/],
      [folder, ['map', 'flow.js', '--out', ''], /^dwfb map: Name the flow map file with --out <file>\.\n/],
      [folder, ['map', 'flow.js', '--config', ''], /^dwfb map: Name the config file with --config <path>\.\n/],
      [folder, ['map', 'flow.js', '--out', 'maps/'], /^dwfb map: The out path maps\/ names a folder, so name a file with --out <file>\.\n/],
      [folder, ['map', 'flow.js', '--out', 'maps/', '--json'], /^dwfb map: The out path maps\/ names a folder, so name a file with --out <file>\.\n/],
      [folder, ['map', ...FLOW_SCENARIOS_ARGS], /^dwfb map: Name the script that --scenarios maps\.\n/],
      [folder, ['map', '--out', 'x.md'], /^dwfb map: Name the script whose flow map --out writes\.\n/],
      [folder, ['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--config', 'dwfb.config.js'], /^dwfb map: Name --scenarios or --config, not both, since a named scenarios file needs no config file\.\n/],
      [folder, ['map', 'flow.js', '--verbose'], /^dwfb map: Unknown option '--verbose'/],
      [folder, ['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--check'], /^dwfb map: Name the flow map file that --check compares with --out <file>, since a named scenarios file reads no config file\.\n$/],
      [folder, ['map', 'plain.js', '--check'], /^dwfb map: Name the flow map file that --check compares with --out <file>, since no map of the config file names one\.\n$/],
      [folder, ['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', './flow.js'], /^dwfb map: The flow map file \.\/flow\.js names the script flow\.js, which the flow map would replace\.\n$/],
      // The real path of FLOW.js keeps that spelling where file names keep letter case, and is flow.js on Windows.
      [folder, ['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', 'FLOW.js'], /^dwfb map: The flow map file FLOW\.js names the script flow\.js( where file names ignore letter case)?, which the flow map would replace\.\n$/],
      [folder, ['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', 'flow.scenarios.js'], /^dwfb map: The flow map file flow\.scenarios\.js names the scenarios file flow\.scenarios\.js, which the flow map would replace\.\n$/],
      [folder, ['map', 'flow.js', '--out', 'flow.entry.js'], /^dwfb map: The flow map file flow\.entry\.js names the entry flow\.entry\.js, which the flow map would replace\.\n$/],
      [folder, ['map', 'flow.js', '--scenarios', 'missing.js'], /^dwfb map: The scenarios file missing\.js does not exist/],
      [emptyFolder, ['map'], /^dwfb map: The config file dwfb\.config\.js has no workflow with map, so give a workflow map, or name a script\.\n$/],
      [await makeTemporaryFolder(), ['map'], /^dwfb map: No config file dwfb\.config\.js or dwfb\.config\.mjs exists here, so name a script, or name a config file with --config <path>\.\n$/],
    ];

    for (const [cwd, args, message] of cases) {
      const { status, stdout, stderr } = runCommand(args, cwd);
      assert.deepEqual({ status, stdout }, { status: 2, stdout: '' }, args.join(' '));
      assert.match(stderr, message, args.join(' '));
    }
    assert.equal((await readdir(folder)).includes('maps'), false);
  });

  it('refuses a flow map file that names a source the entry reaches, of the config workflow or of the banner, and writes nothing', async () => {
    const folder = await writeMapFolder();
    const banner = `// Built by dynamic-workflow-bundler from flow.entry.js. Edit the source, not this file.\n`;
    await writeFile(join(folder, 'flow.entry.js'), "export const meta = { name: 'flow', description: 'd' };\nimport { prompt } from './prompt.js';\nawait agent(prompt, { label: 'work' });\n");
    await writeFile(join(folder, 'prompt.js'), "export const prompt = 'Work.';\n");
    await writeFile(join(folder, 'banner.js'), FLOW_SCRIPT.replace('\n', `\n${banner}`));
    const message = 'dwfb map: The flow map file prompt.js names the source prompt.js of the entry flow.entry.js, which the flow map would replace.\n';

    assert.deepEqual(runCommand(['map', 'flow.js', '--out', 'prompt.js'], folder), { status: 2, stdout: '', stderr: message });
    assert.deepEqual(runCommand(['map', 'banner.js', ...FLOW_SCENARIOS_ARGS, '--out', 'prompt.js'], folder), { status: 2, stdout: '', stderr: message });
    assert.deepEqual(runCommand(['map', 'banner.js', ...FLOW_SCENARIOS_ARGS, '--out', 'flow.entry.js'], folder), {
      status: 2,
      stdout: '',
      stderr: 'dwfb map: The flow map file flow.entry.js names the entry flow.entry.js, which the flow map would replace.\n',
    });
    assert.equal(await readFile(join(folder, 'prompt.js'), 'utf8'), "export const prompt = 'Work.';\n");
  });

  it('refuses a config map that names a source the entry of a workflow with no map reaches, and writes nothing', async () => {
    const folder = await writeMapFolder();
    await writeFile(join(folder, 'dwfb.config.js'), CONFIG.replace('maps/flow.flow-map.md', 'prompt.js'));
    await writeFile(join(folder, 'plain.entry.js'), "export const meta = { name: 'plain', description: 'd' };\nimport { prompt } from './prompt.js';\nawait agent(prompt, { label: 'work' });\n");
    await writeFile(join(folder, 'prompt.js'), "export const prompt = 'Work.';\n");
    const stderr = 'dwfb map: The flow map file prompt.js names the source prompt.js of the entry plain.entry.js, which the flow map would replace.\n';

    for (const args of [['map'], ['map', 'flow.js'], ['map', 'flow.js', '--check']]) assert.deepEqual(runCommand(args, folder), { status: 2, stdout: '', stderr }, args.join(' '));
    assert.equal(await readFile(join(folder, 'prompt.js'), 'utf8'), "export const prompt = 'Work.';\n");
    assert.equal((await readdir(folder)).includes('maps'), false);
  });

  it('maps a script whose banner names an entry that is a folder, refuses a flow map file at that folder, and names a script it cannot read', async () => {
    const folder = await writeMapFolder();
    const banner = `// Built by dynamic-workflow-bundler from entries. Edit the source, not this file.\n`;
    await mkdir(join(folder, 'entries'));
    await writeFile(join(folder, 'banner.js'), FLOW_SCRIPT.replace('\n', `\n${banner}`));
    await writeSizedFile(join(folder, 'large.js'), READ_BYTE_LIMIT + 1);
    const largeRun = runCommand(['map', 'large.js', ...FLOW_SCENARIOS_ARGS, '--out', 'large.md'], folder);

    assert.deepEqual(runCommand(['map', 'banner.js', ...FLOW_SCENARIOS_ARGS, '--out', 'banner.md'], folder), { status: 0, stdout: 'Wrote banner.md.\n', stderr: '' });
    assert.deepEqual(runCommand(['map', 'banner.js', ...FLOW_SCENARIOS_ARGS, '--out', 'entries'], folder), {
      status: 2,
      stdout: '',
      stderr: 'dwfb map: The flow map file entries names the entry entries, which the flow map would replace.\n',
    });
    assert.deepEqual(runCommand(['map', 'missing.js', ...FLOW_SCENARIOS_ARGS, '--out', 'missing.md'], folder), { status: 2, stdout: '', stderr: 'dwfb map: The script file missing.js does not exist.\n' });
    assert.deepEqual({ status: largeRun.status, stderr: largeRun.stderr }, { status: 1, stderr: '' });
    assert.match(largeRun.stdout, /^large\.js:1:1 script-too-large /);
    assert.deepEqual((await readdir(folder)).filter((name) => name.endsWith('.md')), ['banner.md']);
  });

  it('names two flow map files of the config file that name one file through a link, and writes nothing', async () => {
    const folder = await writeMapFolder();
    await mkdir(join(folder, 'maps'));
    await symlink(join(folder, 'maps'), join(folder, 'linked'), 'junction');
    await writeFile(join(folder, 'dwfb.config.js'), CONFIG.replace('maps/flow.flow-map.md', 'linked/gap.flow-map.md'));
    const { status, stdout, stderr } = runCommand(['map'], folder);

    assert.deepEqual({ status, stdout }, { status: 2, stdout: '' });
    assert.equal(stderr, 'dwfb map: The flow map file linked/gap.flow-map.md names the flow map file maps/gap.flow-map.md of the script gap.js, which the flow map would replace.\n');
    assert.deepEqual(await readdir(join(folder, 'maps')), []);
  });

  it('refuses a flow map path that names a folder or is inside a file before it writes any flow map', async () => {
    const folder = await writeMapFolder();
    await writeFile(join(folder, 'gap.scenarios.js'), FLOW_SCENARIOS);
    await writeFile(join(folder, 'gap.js'), FLOW_SCRIPT);
    await mkdir(join(folder, 'maps', 'flow.flow-map.md'), { recursive: true });
    const cases = [
      [['map'], 'dwfb map: The flow map path maps/flow.flow-map.md is not a file.\n'],
      [['map', '--check'], 'dwfb map: The flow map path maps/flow.flow-map.md is not a file.\n'],
      [['map', '--check', '--json'], 'dwfb map: The flow map path maps/flow.flow-map.md is not a file.\n'],
      [['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', 'maps'], 'dwfb map: The flow map path maps is not a file.\n'],
      [['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', 'flow.scenarios.js/deeper/flow.md'], 'dwfb map: The flow map path flow.scenarios.js/deeper/flow.md is inside a file.\n'],
    ];

    for (const [args, stderr] of cases) assert.deepEqual(runCommand(args, folder), { status: 2, stdout: '', stderr }, args.join(' '));
    // --json with no --check reads and writes no flow map file, so it skips the checks of the flow map files on disk.
    for (const args of [['map', '--json'], ['map', 'flow.js', ...FLOW_SCENARIOS_ARGS, '--out', 'maps', '--json']]) {
      const { status, stdout, stderr } = runCommand(args, folder);
      assert.deepEqual({ status, stderr, files: JSON.parse(stdout).maps.map(({ file }) => file) }, { status: 0, stderr: '', files: args.length === 2 ? ['maps/gap.flow-map.md', 'maps/flow.flow-map.md'] : ['maps'] }, args.join(' '));
    }
    assert.deepEqual(await readdir(join(folder, 'maps')), ['flow.flow-map.md']);
  });

  it('names each flow map written before a failed write, and exits 2', async (context) => {
    if (process.getuid?.() === 0) return context.skip('root writes every folder');
    const folder = await writeMapFolder();
    await writeFile(join(folder, 'gap.scenarios.js'), FLOW_SCENARIOS);
    await writeFile(join(folder, 'gap.js'), FLOW_SCRIPT);
    await writeFile(join(folder, 'dwfb.config.js'), CONFIG.replace('maps/flow.flow-map.md', 'locked/flow.flow-map.md'));
    await mkdir(join(folder, 'locked'));
    await writeFile(join(folder, 'locked', 'flow.flow-map.md'), 'old\n');
    // Windows refuses a rename over a read-only file, and POSIX refuses to create a file in a folder with no write permission.
    const lockedPath = process.platform === 'win32' ? join(folder, 'locked', 'flow.flow-map.md') : join(folder, 'locked');
    const cause = process.platform === 'win32' ? '(rename EPERM)' : '(open EACCES)';
    await chmod(lockedPath, process.platform === 'win32' ? 0o444 : 0o555);

    try {
      assert.deepEqual(runCommand(['map'], folder), {
        status: 2,
        stdout: 'Wrote maps/gap.flow-map.md.\n',
        stderr: `dwfb map: Could not read or write locked/flow.flow-map.md ${cause}. Wrote maps/gap.flow-map.md before the failure.\n`,
      });
      assert.equal(await readFile(join(folder, 'maps', 'gap.flow-map.md'), 'utf8'), await formatExpectedFlowMap(folder));
      assert.equal(await readFile(join(folder, 'locked', 'flow.flow-map.md'), 'utf8'), 'old\n');
    } finally {
      await chmod(lockedPath, process.platform === 'win32' ? 0o644 : 0o755);
    }
  });

  it('names the workflow of a scenarios file that does not load, and maps nothing before a later workflow fails', async () => {
    const folder = await writeMapFolder();
    await writeFile(join(folder, 'flow.scenarios.js'), 'export default [{ name: 1 }];\n');
    await writeFile(join(folder, 'gap.scenarios.js'), FLOW_SCENARIOS);
    await writeFile(join(folder, 'gap.js'), FLOW_SCRIPT);
    const { status, stdout, stderr } = runCommand(['map'], folder);

    assert.deepEqual({ status, stdout }, { status: 2, stdout: '' });
    assert.match(stderr, /^dwfb map: The scenarios of the workflow whose entry is flow\.entry\.js cannot load\. /);
    assert.equal((await readdir(folder)).includes('maps'), false);
  });

  it('writes the flow map that the README section on dwfb map shows, for the example script of dwfb simulate', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const section = sliceMarkdownSection(readme, README_SECTION_HEADING);
    const exampleFiles = [...sliceMarkdownSection(readme, README_SIMULATE_HEADING).matchAll(README_FILE_PATTERN), ...section.matchAll(README_FILE_PATTERN)].map((match) => match.groups);
    const run = README_RUN_PATTERN.exec(section)?.groups;
    const mapFile = README_MAP_FILE_PATTERN.exec(section)?.groups;
    const folder = await makeTemporaryFolder();

    assert.deepEqual(exampleFiles.map(({ path }) => path), ['.claude/workflows/review.js', 'workflows/review/scenarios.js', 'workflows/review/scenarios.js']);
    assert.ok(run !== undefined, 'The README section on dwfb map shows no $ dwfb map command');
    assert.ok(mapFile !== undefined, 'The README section on dwfb map shows no flow map file');
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    for (const { path, code } of exampleFiles) {
      await mkdir(join(folder, dirname(path)), { recursive: true });
      await writeFile(join(folder, path), code);
    }
    assert.deepEqual(runCommand(run.args.split(' '), folder), { status: 0, stdout: run.output, stderr: '' });
    assert.equal(await readFile(join(folder, mapFile.path), 'utf8'), mapFile.text);
  });

  it('prints its usage for map --help, and the main usage lists it', () => {
    const { status, stdout } = runCommand(['map', '--help']);

    assert.equal(status, 0);
    assert.match(stdout, /^Usage: dwfb map \[<script>\] \[--scenarios <file>\] \[--out <file>\] \[options\]\n[^]*\n {2}--out <file> {9}Write the flow map to this file\.\n/);
    assert.match(runCommand(['--help']).stdout, /\n {2}map \[<script>\] \[--scenarios <file>\] \[--out <file>\]\n {35}Run a workflow script against each scenario/);
  });
});

describe('dwfb validate', () => {
  const META = "export const meta = { name: 'p', description: 'd' };\n";
  const CLOCK_SCRIPT = `${META}\nconst started = Date.now();\nreturn started;\n`;
  const CLOCK_LINE = 'clock.js:3:17 clock-unavailable The script uses Date.now, which throws in the runtime when called. Pass the time through args, or stamp the result after the workflow returns.\n';
  const PASSED = 'breaks no rule of the contract measured on Claude Code 2.1.332.';

  /**
   * @returns {Promise<string>} A new folder that holds clock.js, which has one finding, and clean.js, which has none.
   */
  async function writeScripts() {
    const folder = await makeTemporaryFolder();
    await writeFile(join(folder, 'clock.js'), CLOCK_SCRIPT);
    await writeFile(join(folder, 'clean.js'), `${META}return 1;\n`);
    return folder;
  }

  /**
   * Copies the config project fixture into a temporary folder and builds its workflows there.
   * @returns {Promise<string>}
   */
  async function buildProjectFixture() {
    const folder = await makeTemporaryFolder();
    await cp(join(CONFIG_FIXTURES, 'project'), folder, { recursive: true });
    runCommand(['build'], folder);
    return folder;
  }

  it('prints each finding of one script in the finding format and exits 1', async () => {
    const folder = await writeScripts();

    assert.deepEqual(runCommand(['validate', 'clock.js'], folder), { status: 1, stdout: CLOCK_LINE, stderr: '' });
    assert.deepEqual(runCommand(['validate', 'clean.js'], folder), { status: 0, stdout: `clean.js ${PASSED}\n`, stderr: '' });
  });

  it('checks several scripts in the order named, and exits 1 when one has a finding', async () => {
    const folder = await writeScripts();

    assert.deepEqual(runCommand(['validate', 'clean.js', 'clock.js', './clean.js'], folder), { status: 1, stdout: `clean.js ${PASSED}\n${CLOCK_LINE}clean.js ${PASSED}\n`, stderr: '' });
  });

  it('checks the out of each workflow of the config file with no script, in order', async () => {
    const folder = await buildProjectFixture();

    assert.deepEqual(runCommand(['validate'], folder), { status: 0, stdout: `dist/review.js ${PASSED}\ndist/summary.js ${PASSED}\n`, stderr: '' });
    await cp(join(folder, 'dwfb.config.js'), join(folder, 'other.config.js'));
    await rm(join(folder, 'dwfb.config.js'));
    assert.deepEqual(runCommand(['validate', '--config', 'other.config.js'], folder), { status: 0, stdout: `dist/review.js ${PASSED}\ndist/summary.js ${PASSED}\n`, stderr: '' });
  });

  it('prints one JSON object with --json, for named scripts and for the config file', async () => {
    const folder = await writeScripts();
    const projectFolder = await buildProjectFixture();

    const scripts = runCommand(['validate', 'clean.js', 'clock.js', '--json'], folder);
    const config = runCommand(['validate', '--json'], projectFolder);

    assert.deepEqual({ status: scripts.status, stderr: scripts.stderr }, { status: 1, stderr: '' });
    assert.deepEqual(JSON.parse(scripts.stdout), {
      ok: false,
      runtime: '2.1.332',
      scripts: [
        { script: 'clean.js', findings: [] },
        {
          script: 'clock.js',
          findings: [{
            rule: 'clock-unavailable',
            message: 'The script uses Date.now, which throws in the runtime when called',
            fix: 'Pass the time through args, or stamp the result after the workflow returns',
            file: 'clock.js',
            line: 3,
            column: 17,
          }],
        },
      ],
      skipped: [],
    });
    assert.deepEqual({ status: config.status, stderr: config.stderr }, { status: 0, stderr: '' });
    assert.deepEqual(JSON.parse(config.stdout), { ok: true, runtime: '2.1.332', scripts: [{ script: 'dist/review.js', findings: [] }, { script: 'dist/summary.js', findings: [] }], skipped: [] });
  });

  it('skips each workflow of the config file with validate: false, and checks a named script whatever the config file says', async () => {
    const folder = await buildProjectFixture();
    const skippedLine = 'Skipped dist/summary.js, since its workflow sets validate: false.\n';
    await writeFile(join(folder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'workflows/review/entry.js', out: 'dist/review.js' }, { entry: 'workflows/summary/entry.js', out: 'dist/summary.js', validate: false }] };\n");
    await writeFile(join(folder, 'dist', 'summary.js'), CLOCK_SCRIPT);

    const json = runCommand(['validate', '--json'], folder);

    assert.deepEqual(runCommand(['validate'], folder), { status: 0, stdout: `dist/review.js ${PASSED}\n${skippedLine}`, stderr: '' });
    assert.deepEqual({ status: json.status, stderr: json.stderr }, { status: 0, stderr: '' });
    assert.deepEqual(JSON.parse(json.stdout), { ok: true, runtime: '2.1.332', scripts: [{ script: 'dist/review.js', findings: [] }], skipped: ['dist/summary.js'] });
    assert.equal(runCommand(['validate', 'dist/summary.js'], folder).status, 1);
  });

  it('names a skipped out through a link as it names a checked script, by the real path', async () => {
    const folder = await makeTemporaryFolder();
    await mkdir(join(folder, 'target'));
    await symlink(join(folder, 'target'), join(folder, 'dist'), 'junction');
    await writeFile(join(folder, 'package.json'), '{ "type": "module" }\n');
    await writeFile(join(folder, 'a.js'), 'export const meta = { name: "a", description: "d" };\nreturn 1;\n');
    await writeFile(join(folder, 'b.js'), 'export const meta = { name: "b", description: "d" };\nreturn 2;\n');
    await writeFile(join(folder, 'target', 'a.js'), 'export const meta = { name: "a", description: "d" };\nreturn 1;\n');
    await writeFile(join(folder, 'dwfb.config.js'), "export default { workflows: [{ entry: 'a.js', out: 'dist/a.js' }, { entry: 'b.js', out: 'dist/b.js', validate: false }] };\n");

    const json = runCommand(['validate', '--json'], folder);

    assert.deepEqual({ status: json.status, stderr: json.stderr }, { status: 0, stderr: '' });
    assert.deepEqual(JSON.parse(json.stdout), { ok: true, runtime: '2.1.332', scripts: [{ script: 'target/a.js', findings: [] }], skipped: ['target/b.js'] });
  });

  it('exits 2 and prints no result for each usage error', async () => {
    const folder = await writeScripts();
    await mkdir(join(folder, 'sub'));
    const projectFolder = await makeTemporaryFolder();
    await cp(join(CONFIG_FIXTURES, 'project'), projectFolder, { recursive: true });
    await cp(join(projectFolder, 'dwfb.config.js'), join(projectFolder, 'other.config.js'));
    const cases = [
      [folder, ['validate', 'clean.js', '--config', 'dwfb.config.js'], /^dwfb validate: Name scripts or --config, not both, since a named script needs no config file\.\n\nUsage: dwfb validate/],
      [folder, ['validate'], /^dwfb validate: No config file dwfb\.config\.js or dwfb\.config\.mjs exists here, so name a script, or name a config file with --config <path>\.\n$/],
      [folder, ['validate', 'missing.js'], /^dwfb validate: The script file missing\.js does not exist\.\n$/],
      [folder, ['validate', 'clean.js', 'sub'], /^dwfb validate: The script sub is not a file\.\n$/],
      [folder, ['validate', 'clean.js/'], /^dwfb validate: The script clean\.js\/ is not a file\.\n$/],
      [folder, ['validate', 'sub/.'], /^dwfb validate: The script sub\/\. is not a file\.\n$/],
      [folder, ['validate', 'sub/..'], /^dwfb validate: The script sub\/\.\. is not a file\.\n$/],
      [folder, ['validate', ''], /^dwfb validate: Name each script by its path\.\n\nUsage: dwfb validate/],
      [folder, ['validate', '--config', ''], /^dwfb validate: Name the config file with --config <path>\./],
      [folder, ['validate', '--config'], /^dwfb validate: Option '--config <value>' argument missing/],
      [folder, ['validate', '--config', 'missing.config.js'], /^dwfb validate: The config file missing\.config\.js does not exist\.\n$/],
      [folder, ['validate', 'clean.js', '--verbose'], /^dwfb validate: Unknown option '--verbose'/],
      [projectFolder, ['validate'], /^dwfb validate: The out file dist\/review\.js of the workflow whose entry is workflows\/review\/entry\.js does not exist, so run dwfb build workflows\/review\/entry\.js\.\n$/],
      [projectFolder, ['validate', '--config', 'other.config.js'], /^dwfb validate: The out file dist\/review\.js .* so run dwfb build workflows\/review\/entry\.js --config other\.config\.js\.\n$/],
    ];

    for (const [cwd, args, message] of cases) {
      const { status, stdout, stderr } = runCommand(args, cwd);
      assert.deepEqual({ status, stdout }, { status: 2, stdout: '' }, args.join(' '));
      assert.match(stderr, message, args.join(' '));
    }
  });

  it('names the file and the cause when the out of a workflow cannot be read, and exits 2', async (context) => {
    const folder = await makeTemporaryFolder();
    await cp(join(CONFIG_FIXTURES, 'project'), folder, { recursive: true });
    await mkdir(join(folder, 'dist'));
    try {
      await symlink(join(folder, 'dist', 'review.js'), join(folder, 'dist', 'review.js'), 'junction');
    } catch (error) {
      if (error.code === 'EPERM') return context.skip('this account cannot create a link');
      throw error;
    }

    assert.deepEqual(runCommand(['validate'], folder), { status: 2, stdout: '', stderr: 'dwfb validate: Could not read or write dist/review.js (stat ELOOP).\n' });
  });

  it('prints its usage for validate --help, and the main usage lists it', () => {
    const { status, stdout } = runCommand(['validate', '--help']);

    assert.equal(status, 0);
    assert.match(stdout, /^Usage: dwfb validate \[<script>\.\.\.\] \[options\]\n[^]*\n {2}--config <path> {3}Read this config file in place of dwfb\.config\.js or dwfb\.config\.mjs\.\n/);
    assert.match(runCommand(['--help']).stdout, /\n {2}validate \[<script>\.\.\.\] +Report each rule/);
  });
});
