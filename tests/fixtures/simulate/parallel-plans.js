export const meta = { name: 'parallel-plans', description: 'Plans three parts with three agents in a parallel.' }
phase('Plan')
const plans = await parallel([
  () => agent('Plan the parser', { label: 'plan parser' }),
  () => agent('Plan the loader', { label: 'plan loader' }),
  () => agent('Plan the writer', { label: 'plan writer' }),
])
log(`plans: ${plans.length}`)
return plans
