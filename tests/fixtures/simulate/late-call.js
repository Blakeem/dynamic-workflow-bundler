export const meta = { name: 'late-call', description: 'Makes one agent call after it returns.' }
Promise.resolve().then(() => agent('Late', { label: 'late' }))
return 'done'
