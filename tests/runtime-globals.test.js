import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { RUNTIME_GLOBAL_NAMES } from '../src/contract.js';
import { installRuntimeGlobals } from '../src/runtime-globals.js';

const RUNTIME_FUNCTION_NAMES = ['agent', 'parallel', 'pipeline', 'workflow', 'phase', 'log', 'setTimeout', 'clearTimeout'];
const REMOVED_NAMES = ['Math', 'JSON', 'console', 'budget'];

/** Compiles installRuntimeGlobals in a fresh context from its source text, as the simulation does. */
function installInContext() {
  const context = createContext(Object.create(null));
  const install = runInContext(`(${installRuntimeGlobals})`, context);
  const globalNames = RUNTIME_GLOBAL_NAMES.filter((name) => !REMOVED_NAMES.includes(name));
  const settings = { globalNames, argsText: '{"a":[1]}', budgetTotal: null, budgetSpent: 0, budgetSpentPerCall: 0 };
  const runtime = install({}, settings);

  return { context, runtime };
}

describe('installRuntimeGlobals', () => {
  it('reads no name of its module, so it runs in a context it is compiled in, and defines functions of that realm with no name', () => {
    const { context } = installInContext();
    const facts = runInContext(`[${RUNTIME_FUNCTION_NAMES.map((name) => `${name} instanceof Function && ${name}.name === ''`).join(', ')}, Object.getPrototypeOf(args) === Object.prototype]`, context);

    assert.deepEqual([...facts], [...RUNTIME_FUNCTION_NAMES.map(() => true), true]);
  });

  it('removes each own global name it is not given', () => {
    const { context } = installInContext();

    assert.equal(runInContext(`[${REMOVED_NAMES.map((name) => `typeof ${name}`).join(', ')}].join(' ')`, context), REMOVED_NAMES.map(() => 'undefined').join(' '));
  });

  it('copies a value into plain objects of the realm, and throws what createCycleError gives for a cycle', () => {
    const { context, runtime } = installInContext();
    const cycle = {};
    const sentinel = Symbol('cycle');

    cycle.self = cycle;
    const copy = runtime.copyValue({ list: [1, , () => 2], f() {}, date: new Date(0) }, () => sentinel);
    assert.equal(Object.getPrototypeOf(copy), runInContext('Object.prototype', context));
    assert.equal(JSON.stringify(copy), '{"list":[1,null,null],"date":{}}');
    assert.throws(() => runtime.copyValue(cycle, () => sentinel), (error) => error === sentinel);
  });
});
