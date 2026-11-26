import { increment } from './counter.js';

log('greet');

export default (name) => `Hello, ${name}. Call ${increment()}.`;
