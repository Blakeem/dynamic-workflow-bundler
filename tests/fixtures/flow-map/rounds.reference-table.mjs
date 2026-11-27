export default {
  engine: 'workflows/rounds.mjs', out: 'out/rounds.md', title: 'rounds',
  scenarios: [{ name: 'two rounds', when: 'a check loops back into two lanes', args: {}, respond: {} }],
};
