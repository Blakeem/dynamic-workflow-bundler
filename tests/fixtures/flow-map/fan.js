export const meta = {
  name: 'fan',
  description: 'Two units, each reviewed through two lenses and then verified.',
  phases: [
    { title: 'Review', detail: 'Reviews each unit through each lens.' },
  ],
};

await pipeline(['u1', 'u2'],
  async (unit) => {
    for (const lens of ['x', 'y']) await agent('Review the unit.', { label: `review:${unit}/${lens}`, phase: 'Review', model: 'sonnet' });
    return unit;
  },
  async (unit) => agent('Verify the unit.', { label: `verify:${unit}`, phase: 'Verify', model: 'sonnet' }));
return {};
