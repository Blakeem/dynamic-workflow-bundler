export const meta = { name: 'copy-return', description: 'Changes the return of one agent call and reads the return of the next.' }
const RECORD_OPTS = { label: 'record', schema: { type: 'object' } }
const first = await agent('First', RECORD_OPTS)
first.items.push('changed')
const second = await agent('Second', RECORD_OPTS)
return { isScriptRealm: Object.getPrototypeOf(first) === Object.prototype && first.items instanceof Array, second: second.items }
