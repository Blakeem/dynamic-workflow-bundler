import { fileURLToPath } from 'node:url';

const SIMULATE_FIXTURES = new URL('../fixtures/simulate/', import.meta.url);

/**
 * @param {string} name A script of tests/fixtures/simulate/, without its ending.
 * @returns {string}
 */
export function findSimulateFixture(name) {
  return fileURLToPath(new URL(`${name}.js`, SIMULATE_FIXTURES));
}
