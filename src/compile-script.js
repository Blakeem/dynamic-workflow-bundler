import { Script } from 'node:vm';

/**
 * Wraps the text after the meta statement as the body of a strict async arrow function, the form Claude
 * Code 2.1.332 compiles.
 * @param {string} script
 * @param {number} metaEnd The offset just after the meta statement.
 * @returns {string}
 */
export function wrapScriptBody(script, metaEnd) {
  return `(async () => {'use strict';${script.slice(metaEnd)}\n})`;
}

/**
 * Compiles a script's body as the runtime does, and runs none of it. Throws the SyntaxError when the text
 * does not compile.
 * @param {string} script
 * @param {number} metaEnd The offset just after the meta statement.
 */
export function compileScript(script, metaEnd) {
  new Script(wrapScriptBody(script, metaEnd));
}
