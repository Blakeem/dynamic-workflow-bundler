export const meta = {
  name: 'schema-probe',
  description: 'Measures how the runtime checks the structured output of an agent against the schema of its call',
  phases: [{ title: 'Schemas' }, { title: 'Returns' }],
}

const REPORT = { errors: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }
const describeError = (error) => 'threw ' + (error && error.name) + ': ' + (error && error.message)

function writeReturnPrompt(inputs, finalInput) {
  const numbered = inputs.map((input, index) => (index + 1) + '. ' + JSON.stringify(input)).join('\n')
  return [
    'This is a measurement of the StructuredOutput tool. Do no other work and call no other tool.',
    'Call StructuredOutput once for each input below, in order, with exactly the JSON shown as the tool input. Change nothing in it, even when it looks wrong for the schema. The purpose is to record what the tool answers to each input.',
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

const RETURN_CASES = [
  {
    key: 'basic keywords',
    schema: {
      type: 'object',
      properties: {
        a: { type: 'string' },
        n: { type: 'integer', minimum: 1 },
        e: { type: 'string', enum: ['x', 'y'] },
        list: { type: 'array', items: { type: 'string' }, maxItems: 2 },
        b: { type: 'boolean' },
        ...REPORT,
      },
      required: ['a'],
    },
    inputs: [
      {},
      { a: 5 },
      { a: null },
      { a: 'x', n: 1.5 },
      { a: 'x', n: '3' },
      { a: 'x', n: 0 },
      { a: 'x', e: 'z' },
      { a: 'x', list: ['a', 2] },
      { a: 'x', list: ['a', 'b', 'c'] },
      { a: 'x', b: 'true' },
    ],
    final: { a: 'x' },
  },
  {
    key: 'extra keys with no additionalProperties',
    schema: { type: 'object', properties: { a: { type: 'string' }, ...REPORT }, required: ['a'] },
    inputs: [{ a: 'x', extra: 1, nested: { k: [1, 'two'] } }],
    final: { a: 'x' },
  },
  {
    key: 'extra key with additionalProperties false',
    schema: { type: 'object', properties: { a: { type: 'string' }, ...REPORT }, required: ['a'], additionalProperties: false },
    inputs: [{ a: 'x', extra: 1 }],
    final: { a: 'x' },
  },
  {
    key: 'default of a missing key',
    schema: { type: 'object', properties: { a: { type: 'string' }, d: { type: 'string', default: 'dflt' }, ...REPORT }, required: ['a'] },
    inputs: [{ a: 'x' }],
    final: { a: 'x' },
  },
  {
    key: 'nested object',
    schema: {
      type: 'object',
      properties: { o: { type: 'object', properties: { k: { type: 'string' } }, required: ['k'] }, ...REPORT },
      required: ['o'],
    },
    inputs: [{ o: {} }, { o: { k: 1 } }, { o: 'text' }],
    final: { o: { k: 'v' } },
  },
]

const SCHEMA_CASES = [
  { key: 'unknown keyword', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], fooBar: 1 } },
  { key: 'unknown type name', schema: { type: 'object', properties: { a: { type: 'strng' } } } },
  { key: 'required names a key that properties lacks', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'zz'] } },
  { key: 'unknown format', schema: { type: 'object', properties: { a: { type: 'string', format: 'no-such-format' } }, required: ['a'] } },
  { key: 'no properties key', schema: { type: 'object' } },
  { key: 'ref into defs', schema: { type: 'object', properties: { a: { $ref: '#/$defs/s' } }, $defs: { s: { type: 'string' } }, required: ['a'] } },
  { key: 'type list with null', schema: { type: 'object', properties: { a: { type: ['string', 'null'] } }, required: ['a'] } },
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
