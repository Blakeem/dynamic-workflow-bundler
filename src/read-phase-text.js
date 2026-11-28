import { isObject } from './is-object.js';

/**
 * Reads one text of an element of the meta object's phases list, so that the flow map and the coverage list the
 * same titles.
 * @param {unknown} phase One element of the meta object's phases list.
 * @param {'title' | 'detail'} key
 * @returns {string} The key's value as text, or '' for a phase that is not an object or lacks the key.
 */
export function readPhaseText(phase, key) {
  return isObject(phase) && phase[key] !== undefined && phase[key] !== null ? String(phase[key]) : '';
}
