const LINE_FEED = 0x0a;

/**
 * Compares bytes, so a script on disk that differs only in its line endings or its encoding differs.
 * @param {Buffer} builtBytes The script the build gives.
 * @param {Buffer} diskBytes The script on disk.
 * @returns {number | null} The 1-based line of the built script that holds the first byte where the two
 *   differ, or null when they are equal. A script on disk that runs past the built script's end differs on
 *   the line after the built script's last line break.
 */
export function findDifferentLine(builtBytes, diskBytes) {
  const sharedLength = Math.min(builtBytes.length, diskBytes.length);
  let offset = 0;
  let line = 1;

  if (builtBytes.equals(diskBytes)) return null;
  while (offset < sharedLength && builtBytes[offset] === diskBytes[offset]) {
    if (builtBytes[offset] === LINE_FEED) line += 1;
    offset += 1;
  }

  return line;
}
