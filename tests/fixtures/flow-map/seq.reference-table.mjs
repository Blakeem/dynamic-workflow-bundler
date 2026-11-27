export default {
  engine: 'workflows/seq.mjs', out: 'out/seq.md', title: 'seq',
  scenarios: [
    { name: 'pass in round 2', when: 'each check passes in round 2', args: {}, respond: { check: (label) => ({ pass: /r2$/.test(label) }) } },
    { name: 'pass in round 1', when: 'each check passes in round 1', args: {}, respond: { check: { pass: true } } },
    { name: 'dies in round 1', when: 'the run dies in round 1', args: { dieRound: 1 }, respond: { check: { pass: true } } },
    { name: 'dies in round 3', when: 'the run dies in round 3', args: { dieRound: 3 }, respond: { check: { pass: true } } },
    { name: 'no block', when: 'the args name no block', args: { early: true }, respond: {} },
  ],
};
