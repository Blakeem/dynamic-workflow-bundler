/**
 * @param {number} count
 * @param {string} noun The singular, which takes an s for any other count than 1.
 * @returns {string} Such as `1 call` or `0 calls`.
 */
export function formatCount(count, noun) {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}
