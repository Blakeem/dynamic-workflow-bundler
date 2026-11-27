import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parseSource, PARSE_OPTIONS } from '../src/parse-source.js';
import { readThrowSites } from '../src/read-throw-sites.js';

const ORACLE = new URL('./fixtures/flow-map/', import.meta.url);

/**
 * @param {string} text
 * @returns {import('../src/read-throw-sites.js').ThrowSite[]}
 */
function readTextSites(text) {
  return readThrowSites(parseSource(text, PARSE_OPTIONS), text);
}

/**
 * @param {string} message The source text of the first argument of the `new` expression.
 * @returns {{ prefix: string, template: string }}
 */
function readMessageText(message) {
  const [site] = readTextSites(`throw new Error(${message});`);
  return { prefix: site.prefix, template: site.template };
}

describe('readThrowSites', () => {
  it('reads a throw of a new expression with a name as callee, at the line of the throw keyword', () => {
    const text = "const a = 1;\nif (a) throw new Error('No block');\nthrow new TypeError(\n  'Wrong type');\n";

    assert.deepEqual(readTextSites(text), [
      { line: 2, prefix: 'No block', template: 'No block' },
      { line: 3, prefix: 'Wrong type', template: 'Wrong type' },
    ]);
  });

  it('counts a line by LF alone, so U+2028 in a string starts no line', () => {
    assert.equal(readTextSites("const a = 'x y';\nthrow new Error('boom');\n")[0].line, 2);
  });

  it('reads no throw of a name, a call, a member callee or a literal', () => {
    assert.deepEqual(readTextSites("throw error;\nthrow Error('x');\nthrow new errors.Usage('x');\nthrow 'x';\nthrow new (pick())('x');"), []);
  });

  it('reads no throw inside a comment or a string', () => {
    assert.deepEqual(readTextSites("// throw new Error('x');\nconst prompt = \"throw new Error('x')\";"), []);
  });

  it('reads a template literal as its text before the first expression and its text with ... per expression', () => {
    assert.deepEqual(readMessageText('`Dead in round ${round}. Resume with ${args}.`'), { prefix: 'Dead in round ', template: 'Dead in round .... Resume with ....' });
    assert.deepEqual(readMessageText('`No block`'), { prefix: 'No block', template: 'No block' });
    assert.deepEqual(readMessageText('`${count} blocks left`'), { prefix: '', template: '... blocks left' });
  });

  it('reads a template literal nested in an expression of another as one expression', () => {
    assert.deepEqual(readMessageText('`Bad ${isLate ? `late ${round}` : `early`} run`'), { prefix: 'Bad ', template: 'Bad ... run' });
  });

  it('reads a concatenation as its leftmost operand', () => {
    assert.deepEqual(readMessageText("'Invalid args (' + error.message + ').'"), { prefix: 'Invalid args (', template: 'Invalid args (' });
    assert.deepEqual(readMessageText("`Round ${round}: ` + reason + '.'"), { prefix: 'Round ', template: 'Round ...: ' });
    assert.deepEqual(readMessageText("reason + ' failed'"), { prefix: '', template: '' });
  });

  it('gives an empty prefix and template for no argument or an expression of another kind', () => {
    assert.deepEqual(readTextSites('throw new Error;\nthrow new Error();'), [
      { line: 1, prefix: '', template: '' },
      { line: 2, prefix: '', template: '' },
    ]);
    for (const message of ['message', 'formatMessage(round)', '...parts', "isLate ? 'late' : 'early'", '1']) {
      assert.deepEqual(readMessageText(message), { prefix: '', template: '' }, message);
    }
  });

  it('lists the sites in source order, a site inside the argument of another included', () => {
    const text = "throw new Error(pick(() => { throw new Error('inner'); }));\nfunction f() { throw new Error('later'); }";

    const switched = "switch (x) {\n  case pick(() => { throw new Error('first'); }):\n    throw new Error('second');\n}";

    assert.deepEqual(readTextSites(text).map((site) => site.template), ['', 'inner', 'later']);
    assert.deepEqual(readTextSites(switched).map((site) => [site.line, site.template]), [[2, 'first'], [3, 'second']]);
  });

  it('gives the sites of the reference readers for the three oracle scripts', async () => {
    const readOracleSites = async (name) => readTextSites(await readFile(new URL(`${name}.js`, ORACLE), 'utf8'));

    assert.deepEqual(await readOracleSites('seq'), [
      { line: 12, prefix: 'No block to build', template: 'No block to build' },
      { line: 20, prefix: 'Dead in round ', template: 'Dead in round .... Resume with the same args.' },
    ]);
    assert.deepEqual(await readOracleSites('fan'), []);
    assert.deepEqual(await readOracleSites('rounds'), []);
  });
});
