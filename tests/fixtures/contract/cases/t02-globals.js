export const meta = { name: 'p', description: 'd' }
const names = ['require', 'process', 'Bun', 'fetch', 'module', 'exports', 'global', 'globalThis', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'performance', 'crypto', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Buffer', 'structuredClone', 'atob', 'btoa', 'WebAssembly', 'SharedArrayBuffer', 'AbortController', 'Event', 'navigator', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'meta', '__filename', '__dirname']
const out = {}
for (const name of names) out[name] = typeof globalThis[name]
out.own = Object.getOwnPropertyNames(globalThis).sort().join(' ')
out.budget = JSON.stringify({ total: budget.total, spent: typeof budget.spent, remaining: typeof budget.remaining, frozen: Object.isFrozen(budget) })
out.console = Object.keys(console).join(' ')
out.argsType = typeof args
return out
