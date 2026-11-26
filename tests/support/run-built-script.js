import { parse } from 'acorn';

// The script body hooks of Claude Code 2.1.332, as its workflow script reference lists them.
const RUNTIME_GLOBALS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow'];

/**
 * Runs a built script as Claude Code 2.1.332 does, as the body of a strict async arrow function after its
 * meta statement, with stand-ins for the runtime globals.
 * @param {string} script
 * @param {object} scriptArgs
 * @returns {Promise<{ value: unknown, logLines: unknown[] }>}
 */
export async function runBuiltScript(script, scriptArgs) {
  const program = parse(script, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  const body = script.slice(program.body[0].end);
  const logLines = [];
  const standIns = { agent: async () => null, parallel: async () => [], pipeline: async () => [], phase: () => {}, log: (line) => logLines.push(line), args: scriptArgs, budget: {}, workflow: {} };
  const run = new Function(...RUNTIME_GLOBALS, `return (async () => {'use strict';${body}\n})();`);
  const value = await run(...RUNTIME_GLOBALS.map((name) => standIns[name]));
  return { value, logLines };
}
