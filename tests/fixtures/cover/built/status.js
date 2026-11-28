// @end-states
export const HALT_STATUS = { done: 'done', halted: 'halted' };

export function checkPlan(plan) {
  if (plan === '') {
    // @unreached the planner gives a plan for every input
    throw new Error('empty plan');
  }
  return plan;
}
