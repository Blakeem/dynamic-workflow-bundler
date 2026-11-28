import Ajv from 'ajv';

// With these options the validator gives the outcome that Claude Code 2.1.332 gave for each schema of
// tests/fixtures/runtime/schema-probe.measured.json. `logger: false` keeps its strict mode warnings off stderr.
const VALIDATOR_OPTIONS = Object.freeze({ validateFormats: false, logger: false });
// The runtime's text leaves out the validator's own start of a schema that breaks the JSON Schema meta-schema.
const INVALID_SCHEMA_START = 'schema is invalid: ';

/**
 * @typedef {object} CompiledSchema
 * @property {string | null} refusal Why the runtime refuses the schema, as the text after
 *   `agent({schema}) received an invalid JSON Schema: `, or null for a schema it takes.
 * @property {((value: unknown) => null) | null} findProblem Null for a refused schema. Gives null for every value.
 */

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

  try {
    validator.compile(schema);
  } catch (error) {
    // The validator's errors for a schema are Error, MissingRefError and, for a bad pattern, SyntaxError.
    if (error instanceof RangeError) throw error;
    return { refusal: readRefusal(error.message), findProblem: null };
  }
  return { refusal: null, findProblem: () => null };
}

/**
 * @param {string} message The message of the error the validator threw.
 * @returns {string}
 */
function readRefusal(message) {
  return message.startsWith(INVALID_SCHEMA_START) ? message.slice(INVALID_SCHEMA_START.length) : message;
}
