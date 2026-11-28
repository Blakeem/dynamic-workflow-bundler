export const meta = {
  name: 'schema-probe-4',
  description: 'Measures which schema values that are no object give a call with no schema',
  phases: [{ title: 'Schemas' }],
}

const describeError = (error) => 'threw ' + (error && error.name) + ': ' + (error && error.message)
const CASES = [
  { key: 'zero', schema: 0 },
  { key: 'empty string', schema: '' },
  { key: 'one', schema: 1 },
  { key: 'function', schema: () => ({ type: 'object' }) },
]

const results = await parallel(CASES.map((probe) => async () => {
  try {
    const value = await agent('This is a measurement. Call no tool. Answer with the one word done.', { label: 'schema:' + probe.key, phase: 'Schemas', schema: probe.schema, effort: 'low' })
    return { key: probe.key, outcome: 'started, returned ' + JSON.stringify(value) }
  } catch (error) {
    return { key: probe.key, outcome: describeError(error) }
  }
}))

return { schemas: results }
