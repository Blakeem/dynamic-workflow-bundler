export default {
  engine: 'workflows/review.mjs', out: 'out/review.md', title: 'review', name: 'review',
  scenarios: [
    { name: 'passes at once', when: 'a', args: {}, respond: { review: { findings: [] }, verify: { pass: true }, summary: 'written' } },
    { name: 'passes in round 2', when: 'b', args: {}, respond: { review: { findings: [] }, verify: (label) => ({ pass: /r2$/.test(label) }), summary: 'written' } },
    { name: 'fails every round', when: 'c', args: {}, respond: { review: { findings: [] }, verify: { pass: false }, summary: 'written' } },
    { name: 'strict review of three units', when: 'd', args: { strict: true, units: ['core', 'tools', 'docs'] }, respond: { review: { findings: [] }, verify: { pass: true }, summary: 'written' } },
  ],
};
