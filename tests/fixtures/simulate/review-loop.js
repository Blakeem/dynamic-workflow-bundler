export const meta = { name: 'review-loop', description: 'Writes a draft and reviews it until a review passes, for up to three rounds.' }
const VERDICT_SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] }
const draft = await agent('Write the draft', { label: 'draft' })
for (let round = 1; round <= 3; round += 1) {
  const review = await agent(`Review round ${round}: ${draft}`, { label: 'review', schema: VERDICT_SCHEMA })
  if (review === null) return { status: 'reviewer died', round }
  if (review.verdict === 'pass') return { status: 'passed', round }
}
return { status: 'failed' }
