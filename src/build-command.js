import { formatDisplayPath } from './display-path.js';

const SHELL_SAFE_PATH_PATTERN = /^[\w./:@+-]+$/;

/**
 * @param {string | undefined} entry
 * @param {{ out?: string, config?: string, 'no-banner'?: boolean }} values The `dwfb build` options.
 * @returns {string} The `dwfb build` command with these options, which a message names as the command that
 *   rewrites a script.
 */
export function formatBuildCommand(entry, values) {
  const args = ['dwfb', 'build'];

  if (entry !== undefined) args.push(formatCommandPath(entry));
  if (values.out !== undefined) args.push('--out', formatCommandPath(values.out));
  if (values.config !== undefined) args.push('--config', formatCommandPath(values.config));
  if (values['no-banner']) args.push('--no-banner');

  return args.join(' ');
}

/**
 * @param {string} path
 * @returns {string} The path relative to the working directory, in double quotes when it holds a character
 *   outside SHELL_SAFE_PATH_PATTERN. cmd, PowerShell and POSIX shells read the quoted path as one argument,
 *   unless it holds `"`, `$`, `` ` ``, `%` or `!`, which a shell still reads inside double quotes.
 */
export function formatCommandPath(path) {
  const displayPath = formatDisplayPath(path);
  return SHELL_SAFE_PATH_PATTERN.test(displayPath) ? displayPath : `"${displayPath}"`;
}
