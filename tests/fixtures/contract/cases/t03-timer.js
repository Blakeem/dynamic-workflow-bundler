export const meta = { name: 'p', description: 'd' }
const started = []
await new Promise((resolve) => setTimeout(resolve, 20))
started.push('timer fired')
const id = setTimeout(() => started.push('late'), 5)
clearTimeout(id)
return started.join(', ') + ', id type ' + typeof id
