export const meta = { name: 'p', description: 'd' }
const out = {}
const attempt = (name, f) => { try { out[name] = 'ok: ' + String(f()) } catch (e) { out[name] = 'threw ' + e.name + ': ' + e.message } }
attempt('Function()', () => Function('return 2')())
attempt('async constructor', () => typeof (async () => {}).constructor('return 2'))
attempt('generator constructor', () => typeof (function* () {}).constructor('yield 2'))
return out
