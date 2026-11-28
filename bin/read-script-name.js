import { PARSE_OPTIONS, parseSource } from '../src/parse-source.js';
import { readMetaValue } from '../src/read-meta-value.js';
import { readScript } from '../src/read-script.js';

/**
 * @param {string} script A script that map() mapped or snapshot() read, so it breaks no rule of the contract.
 * @returns {Promise<string>} The `name` of its meta object, which the meta-name-invalid rule makes a string.
 */
export async function readScriptName(script) {
  const { bytes } = await readScript(script);
  // The runtime of Claude Code 2.1.332 decodes the file with toString('utf-8'), as map() and snapshot() read it.
  const meta = readMetaValue(parseSource(/** @type {Buffer} */ (bytes).toString('utf8'), PARSE_OPTIONS));

  return /** @type {string} */ (meta?.name);
}
