export const meta = { name: 'call-each', description: 'Calls one agent per entry of args.calls, in order, and returns what each call got.' }
const results = []
for (const [index, opts] of args.calls.entries()) {
  results.push(await agent(`Prompt ${index}`, opts ?? undefined))
}
return results
