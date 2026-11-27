import { formatHiddenCharacters } from './format-hidden-characters.js';

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;
// A tag that opens with U, such as Uint8Array or URL, reads with "a".
const AN_TAG_PATTERN = /^[AEIO]/;
// Object.prototype.toString gives `[object <tag>]`.
const TAG_START = '[object ';

/**
 * @typedef {object} NonJsonValue
 * @property {string} path Where the value sits, such as `items[0].name`, or '' for the value itself. Each
 *   character of a key that a terminal does not show reads as its escape.
 * @property {string} kind What the value is, such as `a function` or `a cycle`.
 */

/**
 * Finds the first value that JSON cannot carry as it is: a function, undefined, a BigInt, a symbol, a number
 * that is not finite, a cycle, or an object that is neither a plain object nor an array, such as a Date.
 * An array's hole reads as undefined.
 * @param {unknown} value
 * @returns {NonJsonValue | null} Null when JSON carries the entire value.
 */
export function findNonJsonValue(value) {
  return findInValue(value, [], []);
}

/**
 * @param {unknown} value
 * @param {(string | number)[]} path The keys from the root to the value.
 * @param {object[]} ancestors The objects that hold the value.
 * @returns {NonJsonValue | null}
 */
function findInValue(value, path, ancestors) {
  const kind = describeNonJsonKind(value, ancestors);

  if (kind !== null) return { path: formatPath(path), kind };
  if (value === null || typeof value !== 'object') return null;

  const keys = Array.isArray(value) ? Array.from(value.keys()) : Object.keys(value);
  const holders = [...ancestors, value];

  for (const key of keys) {
    const found = findInValue(value[key], [...path, key], holders);

    if (found !== null) return found;
  }
  return null;
}

/**
 * @param {unknown} value
 * @param {object[]} ancestors
 * @returns {string | null} What the value is, or null when JSON carries it, apart from what it holds.
 */
function describeNonJsonKind(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `the number ${value}`;
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'bigint') return 'a BigInt';
  if (typeof value === 'symbol') return 'a symbol';
  if (ancestors.includes(value)) return 'a cycle';
  if (Array.isArray(value) || isPlainObject(value)) return null;
  return describeObjectKind(value);
}

/**
 * @param {object} value
 * @returns {string} The kind of object, such as `a Date` or `an object of a class`.
 */
export function describeObjectKind(value) {
  const tag = Object.prototype.toString.call(value).slice(TAG_START.length, -1);

  if (Array.isArray(value)) return 'an array';
  if (isPlainObject(value)) return 'an object';
  if (tag === 'Object') return 'an object of a class';
  return `${AN_TAG_PATTERN.test(tag) ? 'an' : 'a'} ${tag}`;
}

/**
 * @param {object} value
 * @returns {boolean} True for an object whose prototype is Object.prototype or null.
 */
export function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {(string | number)[]} path
 * @returns {string}
 */
function formatPath(path) {
  let text = '';

  for (const key of path) {
    if (typeof key === 'number') text += `[${key}]`;
    else if (IDENTIFIER_PATTERN.test(key)) text += text === '' ? key : `.${key}`;
    else text += `[${JSON.stringify(key)}]`;
  }
  return formatHiddenCharacters(text);
}
