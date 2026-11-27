// One ungrouped call loops back into a group of two lanes for two rounds. The loop count of that step
// reads per round, never per lane entered.
export const meta = {
  name: 'rounds',
  description: 'Two lanes of work and then one check, for two rounds.',
  phases: [
    { title: 'Fixture', detail: 'Every call runs here.' },
  ],
};

for (let round = 1; round <= 2; round++) {
  await parallel(['a', 'b'].map((lane) => () => agent(`work ${lane}`, { label: `work:${lane}`, phase: 'Fixture', model: 'sonnet' })));
  await agent('check', { label: `check:r${round}`, phase: 'Fixture', model: 'sonnet' });
}

return { status: 'fixture done' };
