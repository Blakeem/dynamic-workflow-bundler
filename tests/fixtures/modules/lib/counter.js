log('counter');

const state = { count: 0 };

export const counter = state;

export function increment() {
  state.count += 1;
  return state.count;
}
