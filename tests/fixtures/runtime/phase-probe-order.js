export const meta = { name: 'probe-call-phase', description: 'Measure which phase the runtime gives a call. Every agent() call fails its argument check, so no agent starts.' }
const seen = []
const call = async (label, more) => {
  try { await agent('p', { label, schema: [], ...more }); seen.push(label + ' started') } catch (error) { seen.push(label + ' ' + error.name) }
}
await call('before-any-phase')
phase('One')
log('log after phase One')
await call('in-one')
await call('explicit-two', { phase: 'Two' })
await call('after-explicit')
phase('Three')
await parallel([
  async () => { phase('Four'); await call('thunk-a') },
  async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await call('thunk-b') },
])
phase('One')
await call('one-again')
await call('phase-number', { phase: 5 })
await call('phase-empty', { phase: '' })
return seen