import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parseSource, PARSE_OPTIONS } from '../src/parse-source.js';
import { readRolePlaces, readRoles } from '../src/read-roles.js';

const ORACLE = new URL('./fixtures/flow-map/', import.meta.url);

/**
 * @param {string} text
 * @returns {string[]}
 */
function readTextRoles(text) {
  return readRoles(parseSource(text, PARSE_OPTIONS));
}

describe('readRoles', () => {
  it('reads a role from a string literal and from a template literal, with or without an expression', () => {
    assert.deepEqual(readTextRoles("await agent('p', { label: 'dev' });"), ['dev']);
    assert.deepEqual(readTextRoles('await agent(\'p\', { label: "dev" });'), ['dev']);
    assert.deepEqual(readTextRoles('await agent(\'p\', { label: `dev` });'), ['dev']);
    assert.deepEqual(readTextRoles('await agent(\'p\', { label: `review:${unit}/${lens}` });'), ['review']);
  });

  it('reads no role from a value of another kind', () => {
    for (const value of ['name', 'makeLabel()', "isLate ? 'late' : 'early'", "'dev' + id", '1', 'tag`dev`', "{ text: 'dev' }"]) {
      assert.deepEqual(readTextRoles(`await agent('p', { label: ${value} });`), [], value);
    }
  });

  it('reads a role from an object that is no argument of agent()', () => {
    assert.deepEqual(readTextRoles("const opts = { phase: 'Dev', label: 'dev' };\nawait agent('p', opts);"), ['dev']);
  });

  it('reads a key in quotes, and no computed key, shorthand key or default of a pattern', () => {
    assert.deepEqual(readTextRoles("const opts = { 'label': 'dev', \"label\": 'check' };"), ['dev', 'check']);
    assert.deepEqual(readTextRoles("const opts = { ['label']: 'dev', [label]: 'check', label };"), []);
    assert.deepEqual(readTextRoles("function run({ label = 'dev' }) {}\nconst { label: other = 'check' } = opts;"), []);
  });

  it('removes a round marker after a separator only from a template literal with an expression', () => {
    assert.deepEqual(readTextRoles('const a = { label: `dev ${id} r${round}` };'), ['dev']);
    assert.deepEqual(readTextRoles('const a = { label: `gather:r${rounds}` };'), ['gather']);
    assert.deepEqual(readTextRoles('const a = { label: `check/r${round}` };'), ['check']);
    assert.deepEqual(readTextRoles('const a = { label: `r${round}` };'), ['r']);
    assert.deepEqual(readTextRoles("const a = { label: 'dev r' };"), ['dev r']);
    assert.deepEqual(readTextRoles('const a = { label: `dev r` };'), ['dev r']);
  });

  it('removes every separator at the end, and gives no role for an empty result', () => {
    assert.deepEqual(readTextRoles("const a = { label: 'dev :/ ' };"), ['dev']);
    assert.deepEqual(readTextRoles("const a = { label: 'dev\\t' };"), ['dev']);
    for (const value of ["''", "': '", '`${id}`', '` ${id}`']) assert.deepEqual(readTextRoles(`const a = { label: ${value} };`), [], value);
  });

  it('keeps a hyphen and gives each role once, in source order', () => {
    assert.deepEqual(readTextRoles("const a = [{ label: 'final-sweep' }, { label: 'dev' }, { label: `final-sweep ${id}` }];"), ['final-sweep', 'dev']);
    assert.deepEqual(readTextRoles("switch (x) {\n  case f({ label: 'alpha' }):\n    await agent('p', { label: 'beta' });\n}"), ['alpha', 'beta']);
  });

  it('reads no role from label: inside a comment or a string', () => {
    assert.deepEqual(readTextRoles("// { label: 'ghost' }\nconst prompt = \"{ label: 'ghost' }\";\nconst text = `label: ghost`;"), []);
  });

  it('gives the roles of the reference readers for the three oracle scripts', async () => {
    const expected = { seq: ['dev', 'check'], fan: ['review', 'verify'], rounds: ['work', 'check'] };

    for (const [name, roles] of Object.entries(expected)) {
      const text = await readFile(new URL(`${name}.js`, ORACLE), 'utf8');
      assert.deepEqual(readTextRoles(text), roles, name);
    }
  });
});

describe('readRolePlaces', () => {
  it('gives each role once, in source order, at the value of the first label property that gives it', () => {
    const text = "await agent('p', { label: `dev ${id}` });\nawait agent('p', { label: 'check' });\nawait agent('p', { label: 'dev' });";

    assert.deepEqual(readRolePlaces(parseSource(text, PARSE_OPTIONS)), [
      { role: 'dev', offset: text.indexOf('`dev') },
      { role: 'check', offset: text.indexOf("'check'") },
    ]);
  });

  it('gives the roles that readRoles gives, for the three oracle scripts', async () => {
    for (const name of ['seq', 'fan', 'rounds']) {
      const program = parseSource(await readFile(new URL(`${name}.js`, ORACLE), 'utf8'), PARSE_OPTIONS);
      assert.deepEqual(readRolePlaces(program).map(({ role }) => role), readRoles(program), name);
    }
  });
});
