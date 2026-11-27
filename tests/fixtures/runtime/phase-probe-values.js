export const meta = { name: 'probe-call-phase-values', description: 'Measure the phase the runtime gives a call for edge values of phase() and of the phase option. Every agent() call fails its argument check, so no agent starts.' }
const seen = []
const call = async (label, more) => {
  try { await agent('p', { label, schema: [], ...more }); seen.push(label + ' started') } catch (error) { seen.push(label + ' ' + error.name) }
}
const tryPhase = (label, ...values) => { try { seen.push(label + ' gave ' + String(phase(...values))) } catch (error) { seen.push(label + ' threw ' + error.name + ': ' + error.message) } }
phase('Base')
await call('option-null', { phase: null })
await call('option-undefined', { phase: undefined })
await call('option-false', { phase: false })
await call('option-object', { phase: { a: 1 } })
await call('option-zero', { phase: 0 })
tryPhase('phase-number', 5)
await call('after-phase-number')
tryPhase('phase-empty', '')
await call('after-phase-empty')
tryPhase('phase-none')
await call('after-phase-none')
tryPhase('phase-null', null)
await call('after-phase-null')
phase('Base')
await call('no-label-string')
try { await agent('p2', { schema: [] }) } catch (error) { seen.push('no label ' + error.name) }
try { await agent('p3', { label: 7, schema: [] }) } catch (error) { seen.push('label number ' + error.name) }
return seen