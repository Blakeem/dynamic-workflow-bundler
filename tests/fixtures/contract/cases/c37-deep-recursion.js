export const meta = { name: 'p', description: 'd' }
const f = (n) => f(n + 1)
try { f(0) } catch (e) { return e.name + ': ' + e.message }
