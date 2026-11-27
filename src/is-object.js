/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>} True for an object that is not null and not an array.
 */
export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
