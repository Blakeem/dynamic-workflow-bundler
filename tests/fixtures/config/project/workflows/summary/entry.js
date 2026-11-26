export const meta = { name: 'summary', description: 'Summarize a change' };

// @include ./steps/collect.js

return await agent(`Summarize these files.\n${files.join('\n')}`);
