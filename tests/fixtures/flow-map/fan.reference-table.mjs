export default {
  engine: 'workflows/fan.mjs', out: 'out/fan.md', title: 'fan',
  scenarios: [{ name: 'two units', when: 'both units are reviewed', args: {}, respond: {}, terminal: 'inventory of 2 units written' }],
};
