import { open } from 'node:fs/promises';

/**
 * Writes a file of the given size whose bytes are all zero. A truncate that extends a file writes no byte, so
 * the test builds no buffer of that size.
 * @param {string} path
 * @param {number} size
 */
export async function writeSizedFile(path, size) {
  const handle = await open(path, 'w');

  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}
