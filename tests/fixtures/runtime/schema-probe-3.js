export const meta = {
  name: 'schema-probe-3',
  description: 'Measures the order of the schema checks of agent() and a few schema forms, with a schema the runtime is expected to refuse in each case',
  phases: [{ title: 'Schemas' }],
}

const describeError = (error) => 'threw ' + (error && error.name) + ': ' + (error && error.message)

const SCHEMA_CASES = [
  { key: 'root type array with an unknown keyword', schema: { type: 'array', fooBar: 1 } },
  { key: 'no root type with an unknown keyword', schema: { fooBar: 1 } },
  { key: 'empty object', schema: {} },
  { key: 'boolean true', schema: true },
  { key: 'boolean false', schema: false },
  { key: 'root type list with object', schema: { type: ['object', 'null'], properties: { a: { type: 'string' } } } },
  { key: 'ref that names no place', schema: { type: 'object', properties: { a: { $ref: '#/definitions/nope' } }, required: ['a'] } },
  { key: 'ref to another document', schema: { type: 'object', properties: { a: { $ref: 'https://example.com/other.json' } }, required: ['a'] } },
  { key: 'pattern that is no regular expression', schema: { type: 'object', properties: { a: { type: 'string', pattern: '(' } }, required: ['a'] } },
  { key: 'nullable with no type', schema: { type: 'object', properties: { a: { nullable: true } }, required: ['a'] } },
  { key: 'schema uri draft-06', schema: { $schema: 'http://json-schema.org/draft-06/schema#', type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
  { key: 'schema uri draft-04', schema: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
  { key: 'required that is a string', schema: { type: 'object', properties: { a: { type: 'string' } }, required: 'a' } },
  { key: 'minimum that is a string', schema: { type: 'object', properties: { a: { type: 'string' }, n: { type: 'number', minimum: '1' } }, required: ['a'] } },
  { key: 'two unknown keywords', schema: { type: 'object', properties: { a: { type: 'string', zeta: 1 } }, required: ['a'], alpha: 1 } },
  { key: 'unknown keyword and a wrong keyword form', schema: { type: 'object', properties: [], fooBar: 1 } },
]

const results = await parallel(SCHEMA_CASES.map((probe) => async () => {
  try {
    const value = await agent('This is a measurement of the StructuredOutput tool. Call StructuredOutput with exactly the JSON input {"a":"x"} and do nothing else.', { label: 'schema:' + probe.key, phase: 'Schemas', schema: probe.schema, effort: 'low' })
    return { key: probe.key, outcome: 'started, returned ' + JSON.stringify(value) }
  } catch (error) {
    return { key: probe.key, outcome: describeError(error) }
  }
}))

return { schemas: results }
