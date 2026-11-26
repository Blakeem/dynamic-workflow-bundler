// The parse and the rule checks of a 2 MiB script of one-name statements peaked at 450 MB of memory on Node 24.22.1.
// Memory grows with the size, and a 150 MB script exhausted Node's heap.
/**
 * The largest size in bytes of a file that dwfb reads, a workflow script, a source of a build or a file a config
 * file imports, and of an entry with its parts and a built script that the build parses.
 */
export const READ_BYTE_LIMIT = 2097152;

/**
 * @param {number} size The size in bytes of a file larger than READ_BYTE_LIMIT.
 * @returns {string} The size and the limit, as a message that names the file puts them after it.
 */
export function formatOversizeReason(size) {
  return `${size} bytes, which is more than the ${READ_BYTE_LIMIT} bytes dwfb reads`;
}
