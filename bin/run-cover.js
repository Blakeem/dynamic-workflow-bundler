import { parseArgs } from 'node:util';
import { CONTRACT_RUNTIME_VERSION } from '../src/contract.js';
import { cover } from '../src/cover.js';
import { formatCoverJson } from '../src/format-cover-json.js';
import { formatCoverText } from '../src/format-cover-text.js';
import { CONFIG_FILES_TEXT } from '../src/load-config.js';
import { findConfigTargets } from './find-config-targets.js';
import { findScriptTarget, SCENARIOS_CONFIG_CONFLICT } from './find-script-target.js';
import { loadTargetScenarios } from './load-target-scenarios.js';
import { EXIT_FINDINGS, EXIT_SUCCESS, printCommandFailure, printResult, printUsageError } from './print-result.js';

const COVER_USAGE = `Usage: dwfb cover [<script>] [--scenarios <file>] [--config <path>] [--json] [--help]

Runs a workflow script against each scenario of a scenarios file with no model call, as the runtime of
Claude Code ${CONTRACT_RUNTIME_VERSION} runs it, and reports each role, throw site, end state and phase of the
script that no scenario reaches, and each phase that a scenario uses and meta.phases does not list. With no
script, covers the out of each workflow of the config file that has scenarios. With a script and no
--scenarios, reads the scenarios file of the workflow of the config file whose out is the script.

A scenario reaches a role when its simulation makes a call of the role: the longest role of the script that
the call's label starts with. It reaches a throw site when its simulation ends with an error whose newest
frame is the new keyword of the site's throw new <Name>(...) statement. An error that the script catches
reaches no throw site. It reaches an end state when its simulation returns an object whose status is the end
state, or, with no status that is a string of 1 or more characters, when its endState is the end state, with
each run of ASCII digits read as N on both sides. It reaches a phase of meta.phases when a call of its
simulation runs under that phase.

// @end-states alone on the line above a const declaration declares the end states it lists: each string of
its object literal or array literal, which may sit inside Object.freeze(...). A script with no such comment
declares no end state. // @unreached <reason> alone on the line above a throw site marks a throw site that no
scenario can reach, so it gets no finding while no scenario reaches it.

Options:
  --scenarios <file>   Read the scenarios of the script from this file.
  --config <path>      Read this config file in place of ${CONFIG_FILES_TEXT}.
  --json               Print the result as one JSON object.
  --help               Print this help.
`;

const COVER_OPTIONS = Object.freeze({
  scenarios: { type: 'string' },
  config: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean' },
});

/**
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function runCover(args) {
  let parsed = null;
  let targets = null;
  const coverTargets = [];

  try {
    parsed = parseArgs({ args, options: COVER_OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    return printUsageError('dwfb cover', `${error.message}\n\n${COVER_USAGE}`);
  }

  const { values, positionals } = parsed;
  const [script] = positionals;
  if (values.help) return printResult(COVER_USAGE);
  if (positionals.length > 1 || script === '') return printUsageError('dwfb cover', `Name one workflow script.\n\n${COVER_USAGE}`);
  if (values.scenarios === '') return printUsageError('dwfb cover', `Name the scenarios file with --scenarios <file>.\n\n${COVER_USAGE}`);
  if (values.config === '') return printUsageError('dwfb cover', `Name the config file with --config <path>.\n\n${COVER_USAGE}`);
  if (script === undefined && values.scenarios !== undefined) return printUsageError('dwfb cover', `Name the script that --scenarios covers.\n\n${COVER_USAGE}`);
  if (values.scenarios !== undefined && values.config !== undefined) return printUsageError('dwfb cover', `${SCENARIOS_CONFIG_CONFLICT}.\n\n${COVER_USAGE}`);

  // Every script is covered before any result prints, so a usage error of a later script prints no result.
  try {
    targets = script === undefined ? await findConfigTargets(values.config) : [await findScriptTarget(script, values.scenarios, values.config)];
    for (const target of targets) {
      // loadTargetScenarios names the workflow of a scenarios file that does not load, which cover() cannot name.
      await loadTargetScenarios(target);
      coverTargets.push({ scenarios: target.scenariosFile, result: await cover({ script: target.script, scenarios: target.scenariosFile }) });
    }
  } catch (error) {
    return printCommandFailure('dwfb cover', error);
  }

  const results = coverTargets.map(({ result }) => result);
  const isSuccess = results.every((result) => result.ok);
  const exitCode = isSuccess ? EXIT_SUCCESS : EXIT_FINDINGS;
  if (values.json) return printResult(`${JSON.stringify(formatCoverJson(coverTargets, isSuccess), null, 2)}\n`, exitCode);
  return printResult(formatCoverText(results), exitCode);
}
