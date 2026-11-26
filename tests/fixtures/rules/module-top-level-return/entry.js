export const meta = { name: 'module-top-level-return' };
import { ready } from './ready.js';
import { stop } from './stop.js';
return [ready, stop];
