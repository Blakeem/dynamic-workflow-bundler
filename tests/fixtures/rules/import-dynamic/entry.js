export const meta = { name: 'import-dynamic' };
const helper = await import('./helper.js');
return helper;
