import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'acorn';
import { walkScopes } from '../src/walk-scopes.js';

/**
 * @param {string} text
 * @param {string} name
 * @returns {string[][]} For each identifier of that name, the names of each inner scope around it.
 */
function listScopesAround(text, name) {
  const program = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  const found = [];
  walkScopes(program, (node, scopes) => {
    if (node.type === 'Identifier' && node.name === name) found.push(scopes.map((scope) => [...scope].sort().join(',')));
  });
  return found;
}

describe('walkScopes', () => {
  it('gives each node the inner scopes around it, outermost first', () => {
    const text = 'function f(a) { var b; let d; { let c; x; } }';
    assert.deepEqual(listScopesAround(text, 'x'), [['a,arguments', 'b', 'd', 'c']]);
  });

  it('declares no arguments in an arrow function, and the name of a function or class expression in its own scope', () => {
    assert.deepEqual(listScopesAround('const f = (a) => x;', 'x'), [['a', '']]);
    assert.deepEqual(listScopesAround('const f = function g() { x; };', 'x'), [['arguments,g', '', '']]);
    assert.deepEqual(listScopesAround('const K = class L { m() { x; } };', 'x'), [['L', 'arguments', '', '']]);
  });

  it('opens a scope for a catch clause, a lexical loop head, a switch and a static block', () => {
    assert.deepEqual(listScopesAround('try {} catch (e) { x; }', 'x'), [['e', '']]);
    assert.deepEqual(listScopesAround('for (let i of []) x;', 'x'), [['i']]);
    assert.deepEqual(listScopesAround('switch (1) { case 1: let s; x; }', 'x'), [['s']]);
    assert.deepEqual(listScopesAround('class K { static { var v; x; } }', 'x'), [['v']]);
  });
});
