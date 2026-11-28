export const meta = { name: 'built', description: 'A built script whose module holds both directives' };
import { checkPlan, HALT_STATUS } from './status.js';

const plan = await agent('Plan the work.', { label: 'plan' });
checkPlan(plan);
return { status: HALT_STATUS.done };
