export const meta = { name: 'budget-steps', description: 'Runs up to three steps, and returns before a step that the remaining budget cannot pay for.' }
const STEP_COST = 40
const done = []
for (const step of ['plan', 'build', 'review']) {
  if (budget.remaining() < STEP_COST) return { done, spent: budget.spent() }
  done.push(await agent(`Run the ${step} step`, { label: step }))
}
return { done, spent: budget.spent() }
