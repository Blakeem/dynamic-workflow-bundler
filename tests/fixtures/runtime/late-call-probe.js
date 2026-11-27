export const meta = { name: 'probe-late-call', description: 'Measure what the runtime does with an agent() call made after the script returned. Every agent() call fails its argument check, so no agent starts.' }
phase('Body')
const note = (label) => (error) => { log(label + ' threw ' + String(error && error.name) + ': ' + String(error && error.message).slice(0, 120)) }
try { await agent('p', { label: 'before-return', schema: [] }) } catch (error) { note('before-return')(error) }
Promise.resolve().then(() => { log('microtask ran'); return agent('p', { label: 'late-microtask', schema: [] }) }).catch(note('late-microtask'))
setTimeout(() => { log('timer ran'); phase('Late'); agent('p', { label: 'late-timer', schema: [] }).catch(note('late-timer')) }, 30)
return 'returned'