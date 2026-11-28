// Node.js 24.22.1 gives a RangeError of this message when a recursive call overflows the stack.
const STACK_OVERFLOW_MESSAGE = 'Maximum call stack size exceeded';

/**
 * @param {unknown} error
 * @returns {boolean} True for the error of a call stack overflow, which a recursive walk gives on a tree or a value too deep.
 */
export function isStackOverflowError(error) {
  return error instanceof RangeError && error.message === STACK_OVERFLOW_MESSAGE;
}
