export const meta = {
  name: 'seq',
  description: 'Two blocks, each built and checked for up to two rounds.',
  phases: [
    { title: 'Dev', detail: 'Builds one block.' },
    { title: 'Check', detail: 'Checks one block.' },
  ],
};

const VERDICT_SCHEMA = { type: 'object', properties: { pass: { type: 'boolean' } }, required: ['pass'] };

if (args && args.early) throw new Error('No block to build');
for (const id of ['a', 'b']) {
  for (const round of [1, 2]) {
    await agent('Build the block.', { label: `dev ${id} r${round}`, phase: 'Dev', model: 'opus' });
    const verdict = await agent('Check the block.', { label: `check ${id} r${round}`, phase: 'Check', model: 'opus', schema: VERDICT_SCHEMA });
    if (verdict.pass) break;
  }
}
if (args && args.dieRound) throw new Error(`Dead in round ${args.dieRound}. Resume with the same args.`);
return { status: `done (${2} blocks)` };
