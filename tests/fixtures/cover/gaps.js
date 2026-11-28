export const meta = {
  name: 'gaps',
  description: 'A script with one gap of each kind',
  phases: [{ title: 'Plan' }, { title: 'Audit' }],
};

// @end-states
const STATUS = Object.freeze({ done: 'done', halted: 'halted' });

if (args?.mode === 'bad') {
  throw new Error('bad mode');
}
if (args?.mode === 'never') {
  throw new Error('never thrown');
}
await agent('Plan the work.', { label: 'plan', phase: 'Plan' });
if (args?.mode === 'audit') {
  await agent('Audit the work.', { label: 'audit', phase: 'Audit' });
  return { status: STATUS.halted };
}
phase('Ship');
await agent('Ship the work.', { label: 'ship' });
if (args?.mode === 'no plan') {
  // @unreached the planner gives a plan for every input
  throw new Error('no plan');
}
return { status: STATUS.done };
