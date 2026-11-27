import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkConfig } from './check-config.js';
import { importCheckedDefault } from './import-module-file.js';
import { UsageError } from './usage-error.js';

/** @typedef {import('./check-config.js').Config} Config */

// A .mjs config file loads as an ES module in every package, and a .js file only in some.
const CONFIG_FILES = Object.freeze(['dwfb.config.js', 'dwfb.config.mjs']);
/** The config files that a command looks for in the working directory when no `--config` names another. */
export const CONFIG_FILES_TEXT = CONFIG_FILES.join(' or ');

/**
 * Loads the config file a command reads, as loadConfig does: the one `--config` names, else the one of
 * CONFIG_FILES_TEXT that exists in the working directory.
 * Rejects with a UsageError when no `--config` is given and both files exist, since the command cannot tell
 * which one the project means.
 * @param {string | undefined} configPath The path `--config` names.
 * @returns {Promise<{ file: string, config: Config } | null>} The config file as the messages name it, and its
 *   config. Null when no `--config` is given and neither file exists.
 */
export async function loadCommandConfig(configPath) {
  const file = configPath ?? findConfigFile();

  if (file === null) return null;
  if (configPath !== undefined) return { file, config: await loadConfig(file) };

  return { file, config: await readConfig(file, true) };
}

/**
 * @returns {string | null} The config file's name, or null when neither exists.
 */
function findConfigFile() {
  const existingFiles = CONFIG_FILES.filter((file) => existsSync(file));

  if (existingFiles.length > 1) {
    throw new UsageError(`The config files ${existingFiles.join(' and ')} both exist here, so remove one or name one with --config <path>`);
  }

  return existingFiles[0] ?? null;
}

/**
 * Loads a config file as an ES module and checks its default export. Node keeps each module it loads, so
 * a later call in the same process reads the file as the first call loaded it.
 * Rejects with a UsageError for a path that is not a string, a missing file, a folder or a path that ends in a
 * path separator or a `.` or `..` segment, a file that fails to load, a default export that throws as
 * checkConfig reads it, and every problem that checkConfig names.
 * @param {string} path The config file, relative to the working directory or absolute.
 * @returns {Promise<Config>} Every path absolute.
 */
export async function loadConfig(path) {
  if (typeof path !== 'string' || path === '') throw new UsageError('loadConfig() needs path, the path of a config file');

  return readConfig(path, false);
}

/**
 * @param {string} path
 * @param {boolean} isFoundFile True for a file the working directory lookup found. A rename of it to
 *   dwfb.config.mjs then replaces no file and keeps it found, since the lookup found no second config file.
 * @returns {Promise<Config>}
 */
async function readConfig(path, isFoundFile) {
  // A found file that loads as CommonJS is dwfb.config.js, since a .mjs file loads as an ES module.
  const moduleFileRecovery = isFoundFile ? `rename it to ${CONFIG_FILES[1]}` : 'name a .mjs config file with --config';

  return importCheckedDefault(path, `The config file ${path}`, moduleFileRecovery, (value) => checkConfig(value, resolve(path), path));
}
