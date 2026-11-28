/**
 * @param {string} file A real path.
 * @param {string} otherFile A real path that names `file` in the same or another letter case.
 * @returns {string} The end of a message for two paths that name one file only where file names ignore letter case.
 */
export function formatCaseNote(file, otherFile) {
  return file === otherFile ? '' : ' where file names ignore letter case';
}

/**
 * @param {string} pathLabel The path the command would write, such as `The flow map file docs/flow.md`.
 * @param {string} configFile The config file the command read, as the messages name it.
 * @param {string} caseNote What formatCaseNote gives for the two real paths.
 * @returns {string} The message of `dwfb build` and `dwfb map` for a write that would replace the config file.
 */
export function formatConfigFileConflict(pathLabel, configFile, caseNote) {
  return `${pathLabel} names the config file ${configFile}${caseNote}, which the write would replace`;
}
