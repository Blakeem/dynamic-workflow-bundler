import { createFinding } from './finding.js';

/** @typedef {import('./finding.js').Finding} Finding */

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const SINGLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);
const UNICODE_ESCAPE_DIGITS = /^[0-9A-Fa-f]{4}$/;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS = ['true', 'false', 'null'];
const FIRST_CONTROL_CODE = 0x20;

/**
 * @typedef {object} JsonError
 * @property {number} offset
 * @property {string} reason
 */

/**
 * Reports a JSON file that JSON.parse refuses, at the place where its text breaks the JSON grammar.
 * The V8 message of Node.js 24.22.1 names no position for an unexpected token, and it quotes the text,
 * which can hold a line break, so the finding takes its reason and position from findJsonError.
 * @param {string} text The normalized text of the file.
 * @param {string} file
 * @returns {Finding[]}
 */
export function checkJsonFile(text, file) {
  let jsonError = null;

  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    jsonError = findJsonError(text);
    if (jsonError === null) {
      throw new Error(`JSON.parse refuses ${file}, which findJsonError reads as valid, a defect in dynamic-workflow-bundler. ${error.message}`, { cause: error });
    }
  }

  return [createFinding('json-invalid', jsonError.reason, file, text, jsonError.offset)];
}

/**
 * Finds the first place where a text breaks the JSON grammar that JSON.parse reads. It keeps the open
 * arrays and objects on a list, not on the call stack, so a deep nesting cannot overflow the stack.
 * @param {string} text
 * @returns {JsonError | null} Null when the text is valid JSON.
 */
export function findJsonError(text) {
  const containers = [];
  let state = 'value';
  let isCloseAllowed = false;
  let offset = 0;

  for (;;) {
    offset = skipWhitespace(text, offset);
    const character = text[offset];
    const container = containers.at(-1);
    const closer = container === '[' ? ']' : '}';

    if ((state === 'value' || state === 'key') && isCloseAllowed && character === closer) {
      containers.pop();
      offset += 1;
      state = 'after-value';
    } else if (state === 'value' && (character === '[' || character === '{')) {
      containers.push(character);
      offset += 1;
      state = character === '[' ? 'value' : 'key';
      isCloseAllowed = true;
      continue;
    } else if (state === 'value') {
      const end = readScalar(text, offset);
      if (typeof end !== 'number') return end;
      offset = end;
      state = 'after-value';
    } else if (state === 'key') {
      if (character !== '"') return { offset, reason: 'Expected a property name in double quotes' };
      const end = readString(text, offset);
      if (typeof end !== 'number') return end;
      offset = end;
      state = 'colon';
    } else if (state === 'colon') {
      if (character !== ':') return { offset, reason: 'Expected a colon after the property name' };
      offset += 1;
      state = 'value';
    } else if (container === undefined) {
      return offset === text.length ? null : { offset, reason: 'Expected the end of the file after the JSON value' };
    } else if (character === ',') {
      offset += 1;
      state = container === '[' ? 'value' : 'key';
    } else if (character === closer) {
      containers.pop();
      offset += 1;
    } else {
      const element = container === '[' ? 'an array element' : 'a property value';
      return { offset, reason: `Expected a comma or a ${closer} after ${element}` };
    }
    isCloseAllowed = false;
  }
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {number} The offset of the first character that is not JSON whitespace.
 */
function skipWhitespace(text, offset) {
  let end = offset;
  while (WHITESPACE.has(text[end])) end += 1;
  return end;
}

/**
 * @param {string} text
 * @param {number} offset The offset of a value that is not an array or an object.
 * @returns {number | JsonError} The offset just after the value.
 */
function readScalar(text, offset) {
  const character = text[offset];
  const literal = LITERALS.find((word) => text.startsWith(word, offset));

  if (character === '"') return readString(text, offset);
  if (literal !== undefined) return offset + literal.length;
  NUMBER.lastIndex = offset;
  const number = NUMBER.exec(text);
  if (number !== null) return offset + number[0].length;
  if (character === '-') return { offset: offset + 1, reason: 'Expected a digit after the minus sign' };
  return { offset, reason: 'Expected a value' };
}

/**
 * @param {string} text
 * @param {number} offset The offset of the opening quote.
 * @returns {number | JsonError} The offset just after the closing quote.
 */
function readString(text, offset) {
  let index = offset + 1;

  while (index < text.length) {
    const character = text[index];
    if (character === '"') return index + 1;
    if (character.charCodeAt(0) < FIRST_CONTROL_CODE) return { offset: index, reason: 'The string holds a control character, such as a line break' };
    if (character !== '\\') {
      index += 1;
    } else if (SINGLE_ESCAPES.has(text[index + 1])) {
      index += 2;
    } else if (text[index + 1] === 'u' && UNICODE_ESCAPE_DIGITS.test(text.slice(index + 2, index + 6))) {
      index += 6;
    } else {
      return { offset: index, reason: 'The string holds an escape that JSON does not allow' };
    }
  }

  return { offset, reason: 'The string does not end' };
}
