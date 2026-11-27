export const meta = { name: 'schema-checks', description: 'Calls agent() with each kind of schema and describes what each call gave.' }
const tryCall = async (opts) => {
  try {
    const value = await agent('Check', opts)
    return `ok ${value === null ? 'null' : typeof value}`
  } catch (error) {
    return `${error.name}: ${error.message.slice(0, 54)} | instanceof Error ${error instanceof Error}`
  }
}
return [
  await tryCall({ label: 'array', schema: [] }),
  await tryCall({ label: 'array root', schema: { type: 'array' } }),
  await tryCall({ label: 'string', schema: 'x' }),
  await tryCall({ label: 'number', schema: 5 }),
  await tryCall({ label: 'null', schema: null }),
  await tryCall('opts'),
  await tryCall({ label: 'object', schema: { type: 'object' } }),
]
