import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { formatBuildCommand } from '../src/build-command.js';
import { formatDisplayPath } from '../src/display-path.js';
import { MISSING_FILE_CODES } from '../src/load-sources.js';
import { UsageError } from '../src/usage-error.js';

/**
 * Throws a UsageError that names the command that builds the out of a config workflow when no file exists
 * there, since a check of the missing script would name no workflow.
 * @param {{ entry: string, out: string }} workflow
 * @param {string | undefined} configPath The path `--config` names, which the build command names too.
 */
export async function checkBuiltOut(workflow, configPath) {
  const entry = formatDisplayPath(workflow.entry);
  const out = formatDisplayPath(workflow.out);

  if (await isMissingFile(out)) {
    throw new UsageError(`The out file ${out} of the workflow whose entry is ${entry} does not exist, so run ${formatBuildCommand(entry, { config: configPath })}`);
  }
}

/**
 * @param {string} path
 * @returns {Promise<boolean>} True when no file or folder exists at the path.
 */
async function isMissingFile(path) {
  try {
    await stat(resolve(path));
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) return true;
    throw error;
  }
  return false;
}
