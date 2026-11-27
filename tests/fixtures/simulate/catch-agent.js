export const meta = { name: 'catch-agent', description: 'Catches an error of one agent call.' }
try {
  const answer = await agent('Answer', { label: 'answer' })
  log('answered')
  return { answer }
} catch (error) {
  return { caught: String(error) }
}
