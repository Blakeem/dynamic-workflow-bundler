import { Script } from 'node:vm';

/**
 * Compiles the text after the meta statement as the body of a strict async arrow function, as Claude
 * Code 2.1.332 does, and runs none of it. Throws the SyntaxError when the text does not compile.
 * @param {string} script
 * @param {number} metaEnd The offset just after the meta statement.
 */
export function compileScript(script, metaEnd) {
  new Script(`(async () => {'use strict';${script.slice(metaEnd)}\n})`);
}
