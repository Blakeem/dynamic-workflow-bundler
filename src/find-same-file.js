/**
 * @template {{ file: string }} T
 * @param {T[]} realFiles Each with a real path, in the order the command adds them.
 * @param {string} file A real path.
 * @returns {T | undefined} The first entry whose file is `file`, else the first whose file differs from it only in letter case.
 */
export function findSameFile(realFiles, file) {
  const fileKey = file.toLowerCase();

  return realFiles.find((realFile) => realFile.file === file) ?? realFiles.find((realFile) => realFile.file.toLowerCase() === fileKey);
}
