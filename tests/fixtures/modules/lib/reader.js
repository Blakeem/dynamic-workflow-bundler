import { counter } from './counter.js';

log('reader');

export function readCount() {
  return counter.count;
}
