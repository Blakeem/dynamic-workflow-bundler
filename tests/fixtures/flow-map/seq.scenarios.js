export default [
  { name: 'pass in round 2', when: 'each check passes in round 2', respond: { dev: 'built', check: (call) => ({ pass: /r2$/.test(call.label) }) } },
  { name: 'pass in round 1', when: 'each check passes in round 1', respond: { dev: 'built', check: { pass: true } } },
  { name: 'dies in round 1', when: 'the run dies in round 1', expect: 'threw', args: { dieRound: 1 }, respond: { dev: 'built', check: { pass: true } } },
  { name: 'dies in round 3', when: 'the run dies in round 3', expect: 'threw', args: { dieRound: 3 }, respond: { dev: 'built', check: { pass: true } } },
  { name: 'no block', when: 'the args name no block', expect: 'threw', args: { early: true } },
];
