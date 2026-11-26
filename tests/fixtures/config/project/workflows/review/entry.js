export const meta = { name: 'review', description: 'Review a change' };

import { reviewPrompt } from './prompts.js';
import checklist from './checklist.md';

return await agent(reviewPrompt(args.change, checklist));
