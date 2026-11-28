import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { BYTE_ORDER_MARK } from '../src/normalize-source-text.js';
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
 * @returns {{ template: string, isMessageBuilt: boolean }}
 */
function readMessageText(message) {
  const [{ template, isMessageBuilt }] = readTextSites(`throw new Error(${message});`);
  return { template, isMessageBuilt };
}

/**
 * @param {string} text
 * @returns {{ line: number, column: number }} The place of the first throw site.
 */
function readFirstPlace(text) {
  const [{ line, column }] = readTextSites(text);
  return { line, column };
}

describe('readThrowSites', () => {
  it('reads a throw of a new expression with a name as callee, at the place of the new keyword', () => {
    const text = "const a = 1;\nif (a) throw new Error('No block');\nthrow new TypeError(\n  'Wrong type');\nthrow (\n  new RangeError('Far'));\n";

    assert.deepEqual(readTextSites(text), [
      { line: 2, column: 14, template: 'No block', isMessageBuilt: false },
      { line: 3, column: 7, template: 'Wrong type', isMessageBuilt: false },
      { line: 6, column: 3, template: 'Far', isMessageBuilt: false },
    ]);
  });

  it('counts a line at LF and at a lone CR and drops a leading byte order mark, as a frame is placed, so U+2028 in a string starts no line', () => {
    assert.deepEqual(readFirstPlace("const a = 'x y';\nthrow new Error('boom');\n"), { line: 2, column: 7 });
    assert.deepEqual(readFirstPlace("const a = 1;\r\rthrow new Error('boom');\r"), { line: 3, column: 7 });
    assert.deepEqual(readFirstPlace("const a = 1;\r\n\r\nthrow new Error('boom');\r\n"), { line: 3, column: 7 });
    assert.deepEqual(readFirstPlace(`${BYTE_ORDER_MARK}throw new Error('boom');`), { line: 1, column: 7 });
    // An offset lowered by the mark's length over text that still holds the mark lands on the LF, on line 1.
    assert.deepEqual(readFirstPlace(`${BYTE_ORDER_MARK}const a = 1;\nthrow new Error('boom');`), { line: 2, column: 7 });
  });

  it('reads no throw of a name, a call, a member callee or a literal', () => {
    assert.deepEqual(readTextSites("throw error;\nthrow Error('x');\nthrow new errors.Usage('x');\nthrow 'x';\nthrow new (pick())('x');"), []);
  });

  it('reads no throw inside a comment or a string', () => {
    assert.deepEqual(readTextSites("// throw new Error('x');\nconst prompt = \"throw new Error('x')\";"), []);
  });

  it('reads a template literal as its text with ... per expression', () => {
    assert.deepEqual(readMessageText('`Dead in round ${round}. Resume with ${args}.`'), { template: 'Dead in round .... Resume with ....', isMessageBuilt: true });
    assert.deepEqual(readMessageText('`No block`'), { template: 'No block', isMessageBuilt: false });
    assert.deepEqual(readMessageText('`${count} blocks left`'), { template: '... blocks left', isMessageBuilt: true });
  });

  it('reads a template literal nested in an expression of another as one expression', () => {
    assert.deepEqual(readMessageText('`Bad ${isLate ? `late ${round}` : `early`} run`'), { template: 'Bad ... run', isMessageBuilt: true });
  });

  it('reads a concatenation as its leftmost operand, with a message the runtime builds', () => {
    assert.deepEqual(readMessageText("'Invalid args (' + error.message + ').'"), { template: 'Invalid args (', isMessageBuilt: true });
    assert.deepEqual(readMessageText("`Round ${round}: ` + reason + '.'"), { template: 'Round ...: ', isMessageBuilt: true });
    assert.deepEqual(readMessageText("'' + reason"), { template: '', isMessageBuilt: true });
    assert.deepEqual(readMessageText("reason + ' failed'"), { template: '', isMessageBuilt: true });
  });

  it('gives an empty template for no argument, an empty literal or an expression of another kind', () => {
    assert.deepEqual(readTextSites('throw new Error;\nthrow new Error();'), [
      { line: 1, column: 7, template: '', isMessageBuilt: false },
      { line: 2, column: 7, template: '', isMessageBuilt: false },
    ]);
    for (const message of ["''", '``']) {
      assert.deepEqual(readMessageText(message), { template: '', isMessageBuilt: false }, message);
    }
    for (const message of ['message', 'formatMessage(round)', '...parts', "isLate ? 'late' : 'early'", '1']) {
      assert.deepEqual(readMessageText(message), { template: '', isMessageBuilt: true }, message);
    }
  });

  it('lists the sites in source order, a site inside the argument of another included', () => {
    const text = "throw new Error(pick(() => { throw new Error('inner'); }));\nfunction f() { throw new Error('later'); }";

    const switched = "switch (x) {\n  case pick(() => { throw new Error('first'); }):\n    throw new Error('second');\n}";

    assert.deepEqual(readTextSites(text).map((site) => site.template), ['', 'inner', 'later']);
    assert.deepEqual(readTextSites(switched).map((site) => [site.line, site.template]), [[2, 'first'], [3, 'second']]);
  });

  it('gives the lines and templates of the reference readers, and the columns, for the three oracle scripts', async () => {
    const readOracleSites = async (name) => readTextSites(await readFile(new URL(`${name}.js`, ORACLE), 'utf8'));

    assert.deepEqual(await readOracleSites('seq'), [
      { line: 12, column: 31, template: 'No block to build', isMessageBuilt: false },
      { line: 20, column: 34, template: 'Dead in round .... Resume with the same args.', isMessageBuilt: true },
    ]);
    assert.deepEqual(await readOracleSites('fan'), []);
    assert.deepEqual(await readOracleSites('rounds'), []);
  });
});
