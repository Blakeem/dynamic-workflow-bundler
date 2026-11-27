export const meta = { name: 'sim-probe-boundary', description: 'Measures how values cross parallel and pipeline. Calls no agent.' }
const out = {}
const describe = (value) => {
  if (value === undefined) return '<undefined>'
  if (value === null) return 'null'
  if (typeof value === 'function') return '<function>'
  if (typeof value === 'bigint') return '<bigint ' + String(value) + '>'
  if (typeof value === 'symbol') return '<symbol>'
  if (typeof value !== 'object') return typeof value + ' ' + String(value)
  const tag = Object.prototype.toString.call(value)
  const keys = Object.keys(value)
  return tag + ' {' + keys.map((key) => key + ': ' + describe(value[key])).join(', ') + '}'
}
const tryRun = async (key, run) => {
  try { out[key] = 'ok: ' + describe(await run()) } catch (error) { out[key] = 'threw ' + (error && error.name) + ': ' + (error && error.message) }
}
const shared = { a: 1 }
class Point { constructor() { this.x = 1 } get y() { return 2 } }
await tryRun('parallel identity', async () => String((await parallel([() => shared]))[0] === shared))
await tryRun('parallel function value', () => parallel([() => () => 1]))
await tryRun('parallel object with function', () => parallel([() => ({ f() {}, kept: 1 })]))
await tryRun('parallel object with undefined', () => parallel([() => ({ u: undefined, kept: 1 })]))
await tryRun('parallel date', () => parallel([() => new Date(0)]))
await tryRun('parallel map', () => parallel([() => new Map([[1, 2]])]))
await tryRun('parallel set', () => parallel([() => new Set([1])]))
await tryRun('parallel class instance', () => parallel([() => new Point()]))
await tryRun('parallel nan and infinity', () => parallel([() => NaN, () => Infinity, () => -0]))
await tryRun('parallel bigint', () => parallel([() => 1n]))
await tryRun('parallel symbol', () => parallel([() => Symbol('s')]))
await tryRun('parallel error value', () => parallel([() => new Error('e')]))
await tryRun('parallel circular', () => parallel([() => { const o = {}; o.self = o; return o }]))
await tryRun('parallel sparse array', () => parallel([() => [1, , 3]]))
await tryRun('parallel toJSON', () => parallel([() => ({ toJSON() { return 'via toJSON' } })]))
await tryRun('parallel sparse thunks', () => parallel([() => 1, , () => 3]))
await tryRun('parallel thunk not function', () => parallel([() => 1, 2]))
await tryRun('parallel order', async () => { const order = []; await parallel([() => new Promise((resolve) => setTimeout(() => { order.push('slow'); resolve() }, 20)), () => { order.push('fast') }]); return order.join(',') })
await tryRun('parallel runs thunks in same tick', async () => { const order = []; const pending = parallel([() => { order.push('thunk') }]); order.push('after call'); await pending; return order.join(',') })
await tryRun('pipeline identity', async () => String((await pipeline([shared], (value) => value))[0] === shared))
await tryRun('pipeline stage identity', async () => { let same = null; await pipeline([shared], (value) => value, (value, item) => { same = value === shared && item === shared }); return String(same) })
await tryRun('pipeline final undefined', () => pipeline([1], () => undefined))
await tryRun('pipeline final function', () => pipeline([1], () => () => 1))
await tryRun('pipeline null skips later stages', async () => { const seen = []; const result = await pipeline([1], () => null, (value) => { seen.push('stage 2 ran with ' + String(value)); return 'two' }); return JSON.stringify(result) + ' ' + seen.join(',') })
await tryRun('pipeline undefined keeps later stages', async () => { const seen = []; const result = await pipeline([1], () => undefined, (value) => { seen.push('stage 2 ran with ' + String(value)); return 'two' }); return JSON.stringify(result) + ' ' + seen.join(',') })
await tryRun('pipeline false keeps later stages', async () => { const seen = []; const result = await pipeline([1], () => false, (value) => { seen.push('stage 2 ran with ' + String(value)); return 'two' }); return JSON.stringify(result) + ' ' + seen.join(',') })
await tryRun('pipeline throw skips later stages', async () => { const seen = []; const result = await pipeline([1, 2], (value) => { if (value === 1) throw new Error('x'); return value }, (value) => { seen.push('stage 2 ran with ' + String(value)); return 'two' }); return JSON.stringify(result) + ' ' + seen.join(',') })
await tryRun('pipeline items sparse', () => pipeline([1, , 3], (value) => String(value)))
await tryRun('pipeline order', async () => { const order = []; await pipeline([1, 2], (value) => { order.push('s1 i' + value); return value }, (value) => { order.push('s2 i' + value); return value }); return order.join(' ') })
await tryRun('pipeline index and item', () => pipeline(['a', 'b'], (value, item, index) => value + item + index, (value, item, index) => value + '|' + item + index))
await tryRun('log object', () => log({ a: 1 }))
await tryRun('phase twice', () => { phase('One'); phase('One'); return 'done' })
return out
