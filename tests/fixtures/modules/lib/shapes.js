log('shapes');

export class Square {
  static kind = 'square';
  #side;

  constructor(side) {
    this.#side = side;
  }

  area() {
    return this.#side ** 2;
  }
}

export function* corners() {
  yield 'top';
  yield 'bottom';
}

export async function delayed(value) {
  await null;
  return value;
}

const width = 2;
const height = 3;

export { width, height as tall };

export default 'shapes default';
