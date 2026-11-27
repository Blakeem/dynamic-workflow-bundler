export const meta = { name: 'opts-kinds', description: 'Calls agent() with options that JSON cannot hold in full.' }
const cyclic = { label: 'cycle' }
cyclic.self = cyclic
await agent('BigInt', { label: 'big', count: 1n })
await agent('Cycle', cyclic)
await agent('Function', { label: 'run', run: () => 1 })
await agent(42)
return 'done'
