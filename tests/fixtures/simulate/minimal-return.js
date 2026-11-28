export const meta = { name: 'minimal-return', description: 'Asks for a verdict with findings and a score, and returns the review it got.' }
const VERDICT_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, findings: { type: 'array', items: { type: 'string' } }, score: { type: 'integer', minimum: 1 } },
  required: ['verdict', 'findings', 'score'],
}
const review = await agent('Review the change', { label: 'review', schema: VERDICT_SCHEMA })
return { status: review.verdict === 'pass' ? 'passed' : 'failed', review }
