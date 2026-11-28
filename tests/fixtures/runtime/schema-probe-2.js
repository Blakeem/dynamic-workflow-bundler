export const meta = {
  name: 'schema-probe-2',
  description: 'Measures which schema keywords the runtime accepts and how it checks integer, minimum, enum, items, maxItems, format and null',
  phases: [{ title: 'Schemas' }, { title: 'Returns' }],
}

const REPORT = { errors: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }
const describeError = (error) => 'threw ' + (error && error.name) + ': ' + (error && error.message)

function writeReturnPrompt(inputs, finalInput) {
  const numbered = inputs.map((input, index) => (index + 1) + '. ' + JSON.stringify(input)).join('\n')
  return [
    'This is a measurement of the StructuredOutput tool. Do no other work and call no other tool.',
    'Call StructuredOutput once for each input below, in order, with exactly the JSON shown as the tool input. Change nothing in it, even when it looks wrong for the schema. Keep each value in the JSON type shown: a number stays a number, a quoted string stays a quoted string, and null stays null. The purpose is to record what the tool answers to each input.',
    'After each call, keep the answer of the tool word for word.',
    'If a call is accepted, you are done, so stop there.',
    'If a call is rejected, go on with the next input.',
    'Inputs:',
    numbered,
    'After the last input above was rejected, call StructuredOutput with the final input below. In it, replace each <answer N> with the exact text of the answer of the tool to input N. If you could not send an input as written, such as because your tool call was changed or blocked before it reached the tool, write the number of the input and what happened into notes.',
    'Final input:',
    JSON.stringify(finalInput),
  ].join('\n')
}

const answers = (count) => Array.from({ length: count }, (unused, index) => '<answer ' + (index + 1) + '>')
const withA = (more) => ({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'], ...more })

const STANDARD_SCHEMA = {
  type: 'object',
  title: 't',
  description: 'd',
  $comment: 'c',
  definitions: { s: { type: 'string' } },
  $defs: { t: { type: 'string' } },
  properties: {
    a: { type: 'string', minLength: 1, maxLength: 10, pattern: '^x', title: 't', description: 'd', default: 'x', examples: ['x'], const: 'x', deprecated: false, readOnly: false, writeOnly: false },
    n: { type: 'number', multipleOf: 1, maximum: 5, exclusiveMaximum: 6, minimum: 0, exclusiveMinimum: -1 },
    list: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 3, uniqueItems: true, contains: { type: 'string' } },
    o: { type: 'object', properties: { k: { type: 'string' } }, patternProperties: { '^x': { type: 'string' } }, additionalProperties: true, propertyNames: { type: 'string' }, minProperties: 0, maxProperties: 5, dependencies: { k: ['k'] } },
    any: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    one: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    all: { allOf: [{ type: 'string' }] },
    neg: { not: { type: 'number' } },
    cond: { if: { type: 'string' }, then: { type: 'string' }, else: { type: 'number' } },
  },
  required: ['a'],
}

const SCHEMA_CASES = [
  { key: 'every standard draft-07 keyword', schema: STANDARD_SCHEMA },
  { key: 'prefixItems', schema: withA({ properties: { a: { type: 'string' }, t: { type: 'array', prefixItems: [{ type: 'string' }] } } }) },
  { key: 'unevaluatedProperties', schema: withA({ unevaluatedProperties: false }) },
  { key: 'dependentRequired', schema: withA({ dependentRequired: { a: ['a'] } }) },
  { key: 'dependentSchemas', schema: withA({ dependentSchemas: { a: { type: 'object' } } }) },
  { key: 'minContains', schema: withA({ properties: { a: { type: 'string' }, t: { type: 'array', contains: { type: 'string' }, minContains: 1 } } }) },
  { key: 'nullable', schema: withA({ properties: { a: { type: 'string', nullable: true } } }) },
  { key: 'example', schema: withA({ properties: { a: { type: 'string', example: 'x' } } }) },
  { key: 'vendor keyword x-note', schema: withA({ 'x-note': 'n' }) },
  { key: 'schema uri draft 2020-12', schema: withA({ $schema: 'https://json-schema.org/draft/2020-12/schema' }) },
  { key: 'schema uri draft-07', schema: withA({ $schema: 'http://json-schema.org/draft-07/schema#' }) },
  { key: 'id', schema: withA({ $id: 'https://example.com/probe.schema.json' }) },
  { key: 'required with a key twice', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'] } },
  { key: 'enum with no value', schema: withA({ properties: { a: { type: 'string' }, e: { type: 'string', enum: [] } } }) },
  { key: 'properties that is a list', schema: { type: 'object', properties: [] } },
  { key: 'boolean schema of a property', schema: { type: 'object', properties: { a: true }, required: ['a'] } },
]

const RETURN_CASES = [
  {
    key: 'required, integer, minimum, enum, items, maxItems, integer as a string',
    schema: {
      type: 'object',
      properties: {
        a: { type: 'string' },
        n: { type: 'integer', minimum: 1 },
        e: { type: 'string', enum: ['x', 'y'] },
        list: { type: 'array', items: { type: 'string' }, maxItems: 2 },
        ...REPORT,
      },
      required: ['a'],
    },
    inputs: [{}, { a: 'x', n: 1.5 }, { a: 'x', n: 0 }, { a: 'x', e: 'z' }, { a: 'x', list: ['a', 2] }, { a: 'x', list: ['a', 'b', 'c'] }, { a: 'x', n: '3' }],
    final: { a: 'x' },
  },
  {
    key: 'format date',
    schema: { type: 'object', properties: { a: { type: 'string' }, day: { type: 'string', format: 'date' }, ...REPORT }, required: ['a'] },
    inputs: [{ a: 'x', day: 'not-a-date' }],
    final: { a: 'x' },
  },
  {
    key: 'null for a string or null property',
    schema: { type: 'object', properties: { a: { type: 'string' }, maybe: { type: ['string', 'null'] }, ...REPORT }, required: ['a', 'maybe'] },
    inputs: [{ a: 'x', maybe: null }],
    final: { a: 'x', maybe: 'text' },
  },
  {
    key: 'null for a string property',
    schema: { type: 'object', properties: { a: { type: 'string' }, s: { type: 'string' }, count: { type: 'integer' }, flag: { type: 'boolean' }, ...REPORT }, required: ['a'] },
    inputs: [{ a: 'x', count: null }, { a: 'x', flag: null }, { a: 'x', flag: 'yes' }, { a: 'x', count: true }],
    final: { a: 'x' },
  },
]

const schemaResults = await parallel(SCHEMA_CASES.map((probe) => async () => {
  try {
    const value = await agent('This is a measurement of the StructuredOutput tool. Call StructuredOutput with exactly the JSON input {"a":"x"} and do nothing else.', { label: 'schema:' + probe.key, phase: 'Schemas', schema: probe.schema, effort: 'low' })
    return { key: probe.key, outcome: 'started, returned ' + JSON.stringify(value) }
  } catch (error) {
    return { key: probe.key, outcome: describeError(error) }
  }
}))

const returnResults = await parallel(RETURN_CASES.map((probe) => async () => {
  const finalInput = { ...probe.final, errors: answers(probe.inputs.length), notes: '' }
  try {
    const value = await agent(writeReturnPrompt(probe.inputs, finalInput), { label: 'returns:' + probe.key, phase: 'Returns', schema: probe.schema, effort: 'low' })
    return { key: probe.key, inputs: probe.inputs, returned: value }
  } catch (error) {
    return { key: probe.key, inputs: probe.inputs, returned: describeError(error) }
  }
}))

return { schemas: schemaResults, returns: returnResults }
