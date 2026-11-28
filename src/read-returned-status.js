import { isObject } from './is-object.js';

/**
 * @param {unknown} value The value a script returned.
 * @returns {string | null} The `status` of a returned object when it is a string of 1 or more characters, else null.
 */
export function readReturnedStatus(value) {
  return isObject(value) && typeof value.status === 'string' && value.status !== '' ? value.status : null;
}
