#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { build } from '../src/build.js';
import { formatDisplayPath } from '../src/display-path.js';
import { formatFinding } from '../src/format-finding.js';
import { UsageError } from '../src/usage-error.js';

const EXIT_SUCCESS = 0;
const EXIT_FINDINGS = 1;
const EXIT_FAILURE = 2;

const MAIN_USAGE = `Usage: dwfb <command> [options]

Commands:
  build <entry> --out <file>   Build one workflow script from an entry and its modules.

Options:
  --help      Print this help.
  --version   Print the version.

Run dwfb <command> --help to see the options of a command.
`;

const BUILD_USAGE = `Usage: dwfb build <entry> --out <file> [options]

Options:
  --out <file>   Write the built script to this file.
  --no-banner    Leave out the banner line.
  --json         Print the result as one JSON object.
  --help         Print this help.
`;

const BUILD_OPTIONS = Object.freeze({
  out: { type: 'string' },
  'no-banner': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
});

process.exitCode = await runCommand(process.argv.slice(2));

/**
 * @param {string[]} args
 * @returns {Promise<number>} The exit code.
 */
async function runCommand(args) {
  const [command, ...commandArgs] = args;

  const isMainOption = command === '--version' || command === '--help';

  if (command === 'build') return runBuild(commandArgs);
  if (isMainOption && commandArgs.length > 0) return printUsageError('dwfb', `The option ${command} takes no other argument, and ${JSON.stringify(commandArgs[0])} follows it.\n\n${MAIN_USAGE}`);
  if (command === '--version') return printResult(`${readVersion()}\n`);
  if (command === '--help') return printResult(MAIN_USAGE);

  const problem = command === undefined ? 'No command was given' : `Unknown command or option ${command}`;
  return printUsageError('dwfb', `${problem}.\n\n${MAIN_USAGE}`);
}

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function runBuild(args) {
  let parsed = null;
  let result = null;

  try {
    parsed = parseArgs({ args, options: BUILD_OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    return printUsageError('dwfb build', `${error.message}\n\n${BUILD_USAGE}`);
  }

  const { values, positionals } = parsed;
  if (values.help) return printResult(BUILD_USAGE);
  if (positionals.length !== 1 || positionals[0] === '') return printUsageError('dwfb build', `Name one entry file.\n\n${BUILD_USAGE}`);
  if (!values.out) return printUsageError('dwfb build', `Name the built script with --out <file>.\n\n${BUILD_USAGE}`);

  const [entry] = positionals;
  try {
    result = await build({ entry, out: values.out, banner: !values['no-banner'] });
  } catch (error) {
    if (error instanceof UsageError) return printUsageError('dwfb build', `${error.message}.\n`);
    if (isFileSystemError(error)) {
      process.stderr.write(`dwfb build: Could not read or write ${formatDisplayPath(error.path)} (${error.syscall} ${error.code}).\n`);
      return EXIT_FAILURE;
    }
    process.stderr.write(`dwfb build: internal failure.\n${error.stack ?? error}\n`);
    return EXIT_FAILURE;
  }

  const exitCode = result.ok ? EXIT_SUCCESS : EXIT_FINDINGS;
  const bytes = result.ok ? Buffer.byteLength(result.script, 'utf8') : null;
  if (values.json) return printResult(`${JSON.stringify(formatBuildJson(entry, values.out, result, bytes), null, 2)}\n`, exitCode);
  if (!result.ok) return printResult(result.findings.map((finding) => `${formatFinding(finding)}\n`).join(''), exitCode);

  const sourceCount = result.sources.length === 1 ? '1 source file' : `${result.sources.length} source files`;
  return printResult(`Built ${formatDisplayPath(values.out)} from ${sourceCount}, ${bytes} bytes.\n`);
}

/**
 * @param {string} entry
 * @param {string} out
 * @param {import('../src/build.js').BuildResult} result
 * @param {number | null} bytes The built script's size, or null when the build failed.
 * @returns {object} The `--json` shape, which is part of the public interface.
 */
function formatBuildJson(entry, out, result, bytes) {
  return {
    ok: result.ok,
    workflows: [
      {
        entry: formatDisplayPath(entry),
        out: formatDisplayPath(out),
        status: result.ok ? 'written' : 'failed',
        bytes,
        sources: result.sources,
        findings: result.findings,
      },
    ],
  };
}

/**
 * @param {unknown} error
 * @returns {error is NodeJS.ErrnoException & { path: string, syscall: string }} True for a
 *   failed file system call, which names the path it failed on.
 */
function isFileSystemError(error) {
  return error instanceof Error && typeof error.code === 'string' && typeof error.path === 'string' && typeof error.syscall === 'string';
}

/**
 * @returns {string}
 */
function readVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

/**
 * @param {string} text
 * @param {number} [exitCode]
 * @returns {number}
 */
function printResult(text, exitCode = EXIT_SUCCESS) {
  process.stdout.write(text);
  return exitCode;
}

/**
 * @param {string} label
 * @param {string} text
 * @returns {number}
 */
function printUsageError(label, text) {
  process.stderr.write(`${label}: ${text}`);
  return EXIT_FAILURE;
}
