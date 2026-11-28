import Ajv from 'ajv';
import { isStackOverflowError } from './is-stack-overflow-error.js';

// With these options the validator gives the outcome that Claude Code 2.1.332 gave for each schema and each
// return of tests/fixtures/runtime/schema-probe.measured.json. `logger: false` keeps its strict mode warnings off stderr.
const VALIDATOR_OPTIONS = Object.freeze({ validateFormats: false, logger: false });
// The runtime's text leaves out the validator's own start of a schema that breaks the JSON Schema meta-schema.
const INVALID_SCHEMA_START = 'schema is invalid: ';

// The path that Claude Code 2.1.332 names in its answer to an output whose error lies in the value itself.
export const ROOT_PATH = 'root';

// A stack overflow of the check does not tell a loop of `$ref` apart from a deep value, so the text names both.
export const CHECK_OUT_OF_STACK_CAUSE = 'the check of it against the schema runs out of stack, as for a schema whose $ref leads back to itself with no key between or an object nested too deep';
/** What findProblemWithinStack() gives for a check that runs past the stack of the running Node. */
export const CHECK_OUT_OF_STACK = Symbol('check out of stack');

/**
 * @typedef {object} SchemaProblem The first rule of a schema that a value breaks, as the runtime of Claude
 *   Code 2.1.332 answers a rejected output with `Output does not match required schema: <path>: <message>`.
 * @property {string} path `root` for the value itself, or a JSON pointer below it, such as `/o/k`.
 * @property {string} message Such as `must be string`.
 */

/**
 * @typedef {object} CompiledSchema
 * @property {string | null} refusal Why the runtime refuses the schema, as the text after
 *   `agent({schema}) received an invalid JSON Schema: `, or null for a schema it takes.
 * @property {((value: unknown) => SchemaProblem | null) | null} findProblem Null for a refused schema. Gives
 *   null for a JSON value that passes the schema, and for every value under a schema with a truthy `$async`.
 *   Throws a RangeError when the check runs past the stack of the running Node, such as for a schema whose
 *   `$ref` leads back to itself with no key between or a value nested too deep.
 */

/** The compile of a schema the runtime takes whose returns the simulator does not check. */
export const UNCHECKED_SCHEMA = Object.freeze({ refusal: null, findProblem: () => null });

/**
 * Compiles a schema as the runtime of Claude Code 2.1.332 compiles the schema of an agent() call, and prints
 * nothing. Each call compiles with its own validator, so the `$id` of one schema never meets another's.
 * Not measured: the runtime takes a second schema object with an `$id` that an earlier call's schema has.
 * @param {unknown} schema A JSON value.
 * @returns {CompiledSchema}
 * @throws {RangeError} When the compile runs past a limit of the running Node, such as its stack, which a
 *   schema nested a few hundred levels deep or a call from deep recursion reaches. It says nothing of the schema.
 */
export function compileSchema(schema) {
  const validator = new Ajv(VALIDATOR_OPTIONS);
  let validate = null;

  try {
    validate = validator.compile(schema);
  } catch (error) {
    // The validator's errors for a schema are Error, MissingRefError and, for a bad pattern, SyntaxError.
    if (error instanceof RangeError) throw error;
    return { refusal: readRefusal(error.message), findProblem: null };
  }
  // The validator of a schema with a truthy `$async` gives a promise, and Ajv sets its `$async` to true.
  // Not measured: how the runtime checks an output against it.
  if (validate.$async === true) return UNCHECKED_SCHEMA;
  return { refusal: null, findProblem: (value) => (validate(value) ? null : convertError(validate.errors[0])) };
}

/**
 * A check that runs past the stack cannot tell whether the value passes, so it gives a mark and no problem.
 * @param {CompiledSchema} compiled The compile of a schema the runtime takes.
 * @param {unknown} value A JSON value.
 * @returns {SchemaProblem | null | typeof CHECK_OUT_OF_STACK} As findProblem gives, or CHECK_OUT_OF_STACK for a
 *   check that runs past the stack of the running Node.
 */
export function findProblemWithinStack(compiled, value) {
  try {
    return compiled.findProblem(value);
  } catch (error) {
    if (!isStackOverflowError(error)) throw error;
    return CHECK_OUT_OF_STACK;
  }
}

/**
 * Claude Code 2.1.332 adds the forbidden key to the validator's message for `additionalProperties`.
 * @param {import('ajv').ErrorObject} error The first error the validator reports.
 * @returns {SchemaProblem}
 */
function convertError(error) {
  const path = error.instancePath === '' ? ROOT_PATH : error.instancePath;

  if (error.keyword === 'additionalProperties') return { path, message: `${error.message} ('${error.params.additionalProperty}' is not allowed)` };
  return { path, message: error.message };
}

/**
 * @param {string} message The message of the error the validator threw.
 * @returns {string}
 */
function readRefusal(message) {
  return message.startsWith(INVALID_SCHEMA_START) ? message.slice(INVALID_SCHEMA_START.length) : message;
}
