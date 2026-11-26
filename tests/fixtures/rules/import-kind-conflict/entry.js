export const meta = { name: 'import-kind-conflict' };
import { a } from './a.js';
import source from './a.js' with { type: 'text' };
return [a, source];
