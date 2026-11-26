import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const COMMAND = fileURLToPath(new URL('../bin/dwfb.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const MODULES_ENTRY = join(FIXTURES, 'modules', 'entry.js');
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
    assert.match(buildHelp.stdout, /^Usage: dwfb build <entry> --out <file>/);
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

  it('exits 2 for a missing entry, a missing --out, two entries, an empty entry and an --out that is a source', () => {
    const cases = [
      { args: ['build', 'missing.js', '--out', 'out.js'], message: /does not exist/ },
      { args: ['build', 'entry.js'], message: /--out <file>/ },
      { args: ['build', 'entry.js', 'other.js', '--out', 'out.js'], message: /Name one entry file/ },
      { args: ['build', '', '--out', 'out.js'], message: /Name one entry file/ },
      { args: ['build', 'entry.js', '--out', 'lib/counter.js'], message: /is a source/ },
    ];

    for (const { args, message } of cases) {
      const { status, stdout, stderr } = runCommand(args, join(FIXTURES, 'modules'));
      assert.equal(status, 2, args.join(' '));
      assert.equal(stdout, '');
      assert.match(stderr, message);
    }
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

    try {
      const { status, stdout, stderr } = runCommand(['build', 'entry.js', '--out', 'out.js'], folder);
      assert.deepEqual({ status, stdout, stderr }, { status: 2, stdout: '', stderr: `dwfb build: Could not read or write ${failingFile} ${expected}.\n` });
    } finally {
      await chmod(join(folder, failingFile), 0o644);
    }
  });
});
