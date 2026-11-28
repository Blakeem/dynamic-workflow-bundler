export default [
  { name: 'passes at once', respond: { review: { findings: [] }, verify: { pass: true }, '': 'written' } },
  { name: 'passes in round 2', respond: { review: { findings: [] }, verify: (call) => ({ pass: /r2$/.test(call.label) }), '': 'written' } },
  { name: 'fails every round', respond: { review: { findings: [] }, verify: { pass: false }, '': 'written' } },
  { name: 'strict review of three units', args: { strict: true, units: ['core', 'tools', 'docs'] }, respond: { review: { findings: [] }, verify: { pass: true }, '': 'written' } },
];
