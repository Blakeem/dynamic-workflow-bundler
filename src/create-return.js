import { CHECK_OUT_OF_STACK, CHECK_OUT_OF_STACK_CAUSE, compileSchema, findProblemWithinStack, ROOT_PATH } from './compile-schema.js';
import { findNonJsonValue, isPlainObject } from './find-non-json-value.js';
import { isObject } from './is-object.js';
import { UsageError } from './usage-error.js';

/** The letter a string of `minLength` characters repeats. */
const STRING_LETTER = 'x';

/**
 * @typedef {object} MakeContext
 * @property {Record<string, unknown>} root The schema that createReturn() got, which a `$ref` points into.
 * @property {Set<object>} making The object and array schemas whose smallest value is still being made.
 */

/**
 * Makes the minimal return of a schema: the keys of `values`, and for each required key that `values` lacks
 * the smallest value of its schema. A key of `values` whose value is a plain object, under a key whose schema
 * is an object schema, gets the required keys it lacks too. A list in `values` is kept as given.
 * The result for a schema with a truthy `$async` is not checked, as the simulator checks no return against it.
 * @param {unknown} schema The schema of an agent() call, such as `call.opts.schema` in a respond function.
 * @param {unknown} [values] The keys that decide the path of a scenario.
 * @returns {Record<string, unknown>} A new JSON object, which shares no reference with `schema` or `values`.
 * @throws {UsageError} For a schema that is no plain object of JSON values, that agent() refuses or whose
 *   `type` is not `'object'`, for `values` that is no plain object of JSON values, for a result that
 *   breaks the schema, such as for a `pattern` the rules do not read, and for a check of the result that runs
 *   past the stack of the running Node, such as for an `anyOf` whose `$ref` names its own schema or for deep
 *   `values` under a chain of `$ref` or `anyOf` schemas that leads back to an outer schema. A longer chain of
 *   `anyOf` schemas runs the check out of stack at a smaller depth.
 * @throws {RangeError} When the compile of the schema or the JSON check, copy or fill of `values` runs past the
 *   stack of the running Node, such as for a schema nested a few hundred levels deep or `values` nested a few thousand deep,
 *   and for a `minLength` or a `minItems` above the length of a string or an array that the running Node can make.
 *   A smaller `minLength` or `minItems` whose value the heap cannot hold ends the process and throws nothing.
 */
export function createReturn(schema, values = {}) {
  let compiled = null;
  let givenValues = null;
  let result = null;
  let problem = null;

  checkJsonObject(schema, 'schema');
  compiled = compileSchema(schema);
  if (compiled.refusal !== null) throw new UsageError(`createReturn() takes a schema that agent() takes, and agent() refuses this one: ${compiled.refusal}`);
  if (schema.type !== 'object') throw new UsageError("createReturn() takes a schema whose type is 'object', as agent() does");
  checkJsonObject(values, 'values');
  givenValues = copyJson(values);

  result = fillObject(schema, givenValues, { root: schema, making: new Set() });
  problem = findProblemWithinStack(compiled, result);
  if (problem === CHECK_OUT_OF_STACK) throw new UsageError(`createReturn() cannot check its object, since ${CHECK_OUT_OF_STACK_CAUSE}. Change the schema or nest values less deep`);
  if (problem !== null) throw new UsageError(`createReturn() cannot make an object that passes the schema at ${problem.path}: ${problem.message}. ${describeRecovery(problem.path, givenValues)}`);
  return result;
}

/**
 * @param {string} path `root`, or a JSON pointer below it, as findProblem() names it.
 * @param {Record<string, unknown>} givenValues
 * @returns {string} The change to `values` that can make the object pass at that path.
 */
function describeRecovery(path, givenValues) {
  if (path === ROOT_PATH) return 'Change the keys of values';
  return findValueAt(givenValues, path, (token) => token) === undefined ? 'Give that value in values' : 'Change that value in values';
}

/**
 * @param {unknown} value
 * @param {string} name The parameter, as the message names it.
 * @returns {asserts value is Record<string, unknown>}
 */
function checkJsonObject(value, name) {
  let nonJson = null;

  if (!isObject(value) || !isPlainObject(value)) throw new UsageError(`createReturn() takes ${name} as a plain object`);
  nonJson = findNonJsonValue(value);
  if (nonJson !== null) throw new UsageError(`createReturn() takes ${name} as a plain object of JSON values, and it holds ${nonJson.kind} at ${nonJson.path}, which JSON cannot carry`);
}

/**
 * @param {unknown} schema
 * @param {unknown} value A JSON value that no caller holds.
 * @param {MakeContext} context
 * @returns {unknown} The value, with the required keys each plain object lacks under an object schema.
 */
function fillValue(schema, value, context) {
  const objectSchema = isObject(value) ? readObjectSchema(schema, context.root) : null;

  return objectSchema === null ? value : fillObject(objectSchema, value, context);
}

/**
 * @param {Record<string, unknown>} schema A schema whose first type is `'object'`.
 * @param {Record<string, unknown>} values
 * @param {MakeContext} context
 * @returns {Record<string, unknown>} The required keys in the order of `required`, then the other keys of `values`.
 */
function fillObject(schema, values, context) {
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};
  const entries = [];
  // A given object under a `$ref` back to an outer schema re-enters it, and only the outer call may end it.
  const isNewlyMaking = !context.making.has(schema);

  context.making.add(schema);
  for (const key of required) {
    const keySchema = readKeySchema(properties, key);

    entries.push([key, Object.hasOwn(values, key) ? fillValue(keySchema, values[key], context) : makeSmallestValue(keySchema, context)]);
  }
  for (const key of Object.keys(values)) {
    if (!required.includes(key)) entries.push([key, fillValue(readKeySchema(properties, key), values[key], context)]);
  }
  if (isNewlyMaking) context.making.delete(schema);
  // fromEntries defines each key as its own, so a key such as `__proto__` stays a key of the object.
  return Object.fromEntries(entries);
}

/**
 * @param {unknown} schema
 * @param {MakeContext} context
 * @returns {unknown}
 */
function makeSmallestValue(schema, context) {
  const decidingSchema = readDecidingSchema(schema, context.root);

  if (decidingSchema === null) return null;
  if (Object.hasOwn(decidingSchema, 'const')) return copyJson(decidingSchema.const);
  if (Object.hasOwn(decidingSchema, 'enum')) return copyJson(decidingSchema.enum[0]);
  if (context.making.has(decidingSchema)) return null;
  return makeTypedValue(decidingSchema, context);
}

/**
 * @param {Record<string, unknown>} schema A schema with no `const`, `enum`, local `$ref`, `anyOf` or `oneOf`.
 * @param {MakeContext} context
 * @returns {unknown}
 */
function makeTypedValue(schema, context) {
  switch (readFirstType(schema)) {
    case 'object':
      return fillObject(schema, {}, context);
    case 'array':
      return makeArray(schema, context);
    case 'string':
      return STRING_LETTER.repeat(schema.minLength ?? 0);
    case 'number':
      return makeNumber(schema, false);
    case 'integer':
      return makeNumber(schema, true);
    case 'boolean':
      return false;
    default:
      return null;
  }
}

/**
 * @param {Record<string, unknown>} schema A schema whose first type is `'array'`.
 * @param {MakeContext} context
 * @returns {unknown[]}
 */
function makeArray(schema, context) {
  let items = null;

  context.making.add(schema);
  items = Array.from({ length: schema.minItems ?? 0 }, () => makeSmallestValue(schema.items, context));
  context.making.delete(schema);
  return items;
}

/**
 * @param {Record<string, unknown>} schema A schema whose first type is `'number'` or `'integer'`.
 * @param {boolean} isInteger True for the first type `'integer'`.
 * @returns {number} 0, raised to a `minimum` above 0, rounded up for an integer, and to the next integer above
 *   an `exclusiveMinimum` of 0 or more.
 */
function makeNumber(schema, isInteger) {
  let number = 0;

  if (typeof schema.minimum === 'number' && schema.minimum > number) number = isInteger ? Math.ceil(schema.minimum) : schema.minimum;
  if (typeof schema.exclusiveMinimum === 'number' && schema.exclusiveMinimum >= 0) number = Math.max(number, Math.floor(schema.exclusiveMinimum) + 1);
  return number;
}

/**
 * @param {unknown} schema
 * @param {Record<string, unknown>} root
 * @returns {Record<string, unknown> | null} The schema that the rules for its type read, or null for another schema.
 */
function readObjectSchema(schema, root) {
  const decidingSchema = readDecidingSchema(schema, root);
  const hasValueRule = decidingSchema !== null && (Object.hasOwn(decidingSchema, 'const') || Object.hasOwn(decidingSchema, 'enum'));

  return decidingSchema !== null && !hasValueRule && readFirstType(decidingSchema) === 'object' ? decidingSchema : null;
}

/**
 * Follows each local `$ref` to the schema it names, and each `anyOf` and `oneOf` to its first schema.
 * @param {unknown} schema
 * @param {Record<string, unknown>} root
 * @returns {Record<string, unknown> | null} The first schema on the way with a `const` or an `enum`, or with
 *   none of these keywords. Null for a schema that is no object, a `$ref` that names no place and a loop of them.
 */
function readDecidingSchema(schema, root) {
  const followed = new Set();
  let current = schema;

  while (isObject(current) && !followed.has(current)) {
    if (Object.hasOwn(current, 'const') || Object.hasOwn(current, 'enum')) return current;
    followed.add(current);
    if (isLocalReference(current.$ref)) current = findPointedValue(root, current.$ref);
    else if (Object.hasOwn(current, 'anyOf')) current = current.anyOf[0];
    else if (Object.hasOwn(current, 'oneOf')) current = current.oneOf[0];
    else return current;
  }
  return null;
}

/**
 * @param {unknown} reference
 * @returns {reference is string} True for `#` and for a JSON pointer such as `#/$defs/item`.
 */
function isLocalReference(reference) {
  return typeof reference === 'string' && (reference === '#' || reference.startsWith('#/'));
}

/**
 * Reads the fragment as the validator reads it, with percent escapes read before the pointer escapes.
 * It starts at the root, so a pointer under a nested `$id` may name another place, which the check of the result reports.
 * @param {Record<string, unknown>} root
 * @param {string} reference `#` or `#/<path>`.
 * @returns {unknown} Undefined for a pointer that names no place.
 */
function findPointedValue(root, reference) {
  // Ajv drops a trailing `#` or `#/` from a ref, so `#/` names the root and never the key "".
  return reference === '#' || reference === '#/' ? root : findValueAt(root, reference.slice(1), decodeURIComponent);
}

/**
 * @param {unknown} value
 * @param {string} pointer A JSON pointer that names a place below the value, such as `/o/k`.
 * @param {(token: string) => string} decodeToken The step that reads each token before `~1` as `/` and `~0` as `~`.
 * @returns {unknown} Undefined for a pointer that names no place.
 */
function findValueAt(value, pointer, decodeToken) {
  let current = value;

  for (const token of pointer.slice(1).split('/')) {
    const key = decodeToken(token).replaceAll('~1', '/').replaceAll('~0', '~');

    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * @param {Record<string, unknown>} properties
 * @param {string} key
 * @returns {unknown} Undefined for a key that `properties` lacks, a key that Object.prototype has included.
 */
function readKeySchema(properties, key) {
  return Object.hasOwn(properties, key) ? properties[key] : undefined;
}

/**
 * @param {Record<string, unknown>} schema
 * @returns {unknown} The type, or the first type of a type list.
 */
function readFirstType(schema) {
  return Array.isArray(schema.type) ? schema.type[0] : schema.type;
}

/**
 * @param {unknown} value A JSON value.
 * @returns {unknown} A copy that shares no reference with the value.
 */
function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}
