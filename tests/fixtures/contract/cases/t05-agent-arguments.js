export const meta = { name: 'p', description: 'd' }
const out = {}
const quick = { model: 'haiku', effort: 'low' }
const PROMPT = 'Reply with the single word ok. Use no tool.'
const attempt = async (name, f) => { try { const v = await f(); out[name] = 'ok: ' + (JSON.stringify(v) ?? String(v)).slice(0, 160) } catch (e) { out[name] = 'threw ' + (e && e.constructor && e.constructor.name) + ': ' + String(e && e.message).slice(0, 400) } }
await attempt('no prompt', () => agent())
await attempt('number prompt', () => agent(5, quick))
await attempt('empty prompt', () => agent('', quick))
await attempt('opts not object', () => agent(PROMPT, 'haiku'))
await attempt('schema string type', () => agent(PROMPT, { ...quick, schema: { type: 'string' } }))
await attempt('schema no properties', () => agent(PROMPT, { ...quick, schema: { type: 'object' } }))
await attempt('schema required not in properties', () => agent(PROMPT, { ...quick, schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } }))
await attempt('schema not object', () => agent(PROMPT, { ...quick, schema: 'x' }))
await attempt('schema array root', () => agent(PROMPT, { ...quick, schema: { type: 'array', items: { type: 'string' } } }))
await attempt('unknown opts key', () => agent(PROMPT, { ...quick, bogus: 1 }))
await attempt('effort unknown', () => agent(PROMPT, { model: 'haiku', effort: 'ultra' }))
await attempt('model unknown', () => agent(PROMPT, { model: 'no-such-model', effort: 'low' }))
await attempt('isolation unknown', () => agent(PROMPT, { ...quick, isolation: 'docker' }))
await attempt('agentType unknown', () => agent(PROMPT, { ...quick, agentType: 'no-such-agent-type' }))
await attempt('label number', () => agent(PROMPT, { ...quick, label: 5 }))
await attempt('phase number', () => agent(PROMPT, { ...quick, phase: 5 }))
await attempt('valid schema', () => agent('Return ok true.', { ...quick, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } }))
return out
