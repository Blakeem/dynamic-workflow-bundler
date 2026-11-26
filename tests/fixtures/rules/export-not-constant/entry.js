export const meta = { name: 'export-not-constant' };
import { count, total, raise } from './state.js';
raise();
return [count, total];
