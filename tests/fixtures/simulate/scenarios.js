/** @typedef {import('../../../src/simulate.js').Scenario} Scenario */

const VERDICT_FAIL = { verdict: 'fail' };
const VERDICT_PASS = { verdict: 'pass' };

/** @type {Record<string, Scenario>} The scenarios of tests/simulate.test.js, by the fixture script they run with. */
export const SCENARIOS = {
  plansAnswered: { name: 'every plan answered', respond: { plan: (call) => `plan for ${call.label}` } },
  writerUnanswered: { name: 'no writer plan', respond: { 'plan parser': 'parser plan', 'plan loader': 'loader plan' } },
  reviewFailThenPass: { name: 'fail then pass', respond: { draft: 'the draft', review: [VERDICT_FAIL, VERDICT_PASS] } },
  reviewUsedUp: { respond: { draft: 'the draft', review: [VERDICT_FAIL] } },
  reviewString: { respond: { draft: 'the draft', review: 'pass' } },
  reviewDate: { respond: { draft: 'the draft', review: { verdict: 'pass', reviewedAt: new Date(0) } } },
  reviewerDied: { respond: { draft: 'the draft', review: null } },
  answerUnanswered: { respond: { other: 'other answer' } },
  recordShared: { respond: { record: { items: ['kept'] } } },
  schemaChecks: { respond: (call) => (call.opts?.schema ? { checked: true } : 'checked') },
  respondThrows: {
    respond: () => {
      throw new Error('No answer written');
    },
  },
};
