#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { printResult, printUsageError } from './print-result.js';
import { runBuild } from './run-build.js';
import { runInspect } from './run-inspect.js';
import { runLocate } from './run-locate.js';
import { runMap } from './run-map.js';
import { runSimulate } from './run-simulate.js';
import { runSnapshot } from './run-snapshot.js';
import { runValidate } from './run-validate.js';

const MAIN_USAGE = `Usage: dwfb <command> [options]

Commands:
  build [<entry>] [--out <file>]   Build workflow scripts from an entry, its parts, and the modules,
                                   text files and JSON files it imports.
  inspect <script> [--scenarios <file>] [--scenario <name>] [--call <index>]
                                   Run a workflow script against one scenario with no model call, and
                                   print the events of the simulation in order, or one call in full.
  locate <script> <line>[:<column>]
                                   Print the source line that a line of a built script comes from.
  map [<script>] [--scenarios <file>] [--out <file>]
                                   Run a workflow script against each scenario of a scenarios file, with
                                   no model call, and write the flow map of every path they reach.
  simulate [<script>] [--scenarios <file>]
                                   Run a workflow script against each scenario of a scenarios file, with
                                   no model call, and print how each simulation ended.
  snapshot [<script>] [--scenarios <file>] [--out <file>]
                                   Run a workflow script against each scenario of a scenarios file, with
                                   no model call, and write one copy of each distinct prompt per role.
  validate [<script>...]           Report each rule of the runtime's contract that a workflow script
                                   breaks.

Options:
  --help      Print this help.
  --version   Print the version.

Run dwfb <command> --help to see the options of a command.
`;

process.exitCode = await runCommand(process.argv.slice(2));

/**
 * @param {string[]} args
 * @returns {Promise<number>} The exit code.
 */
async function runCommand(args) {
  const [command, ...commandArgs] = args;

  const isMainOption = command === '--version' || command === '--help';

  if (command === 'build') return runBuild(commandArgs);
  if (command === 'inspect') return runInspect(commandArgs);
  if (command === 'locate') return runLocate(commandArgs);
  if (command === 'map') return runMap(commandArgs);
  if (command === 'simulate') return runSimulate(commandArgs);
  if (command === 'snapshot') return runSnapshot(commandArgs);
  if (command === 'validate') return runValidate(commandArgs);
  if (isMainOption && commandArgs.length > 0) return printUsageError('dwfb', `The option ${command} takes no other argument, and ${JSON.stringify(commandArgs[0])} follows it.\n\n${MAIN_USAGE}`);
  if (command === '--version') return printResult(`${readVersion()}\n`);
  if (command === '--help') return printResult(MAIN_USAGE);

  const problem = command === undefined ? 'No command was given' : `Unknown command or option ${command}`;
  return printUsageError('dwfb', `${problem}.\n\n${MAIN_USAGE}`);
}

/**
 * @returns {string}
 */
function readVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}
