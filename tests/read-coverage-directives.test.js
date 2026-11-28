import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BYTE_ORDER_MARK } from '../src/normalize-source-text.js';
import { parseSource, PARSE_OPTIONS } from '../src/parse-source.js';
import { readCoverageDirectives } from '../src/read-coverage-directives.js';
import { readRolePlaces } from '../src/read-roles.js';
import { readThrowSites } from '../src/read-throw-sites.js';

const END_STATES_MISPLACED = 'The // @end-states comment is not alone on the line above a const that lists end states';
const UNREACHED_MISPLACED = 'The // @unreached comment is not alone on the line above a throw site or a label';

/**
 * @param {string} text
 * @returns {import('../src/read-coverage-directives.js').CoverageDirectives}
 */
function readTextDirectives(text) {
  const comments = [];
  const program = parseSource(text, { ...PARSE_OPTIONS, onComment: comments });

  return readCoverageDirectives(program, comments, text, readThrowSites(program, text), readRolePlaces(program));
}

/**
 * @param {string} text
 * @returns {string[]} The end states the text declares.
 */
function readEndStates(text) {
  return readTextDirectives(text).endStates.map(({ endState }) => endState);
}

/**
 * @param {string} text
 * @returns {string[]} The rule of each problem.
 */
function readProblemRules(text) {
  return readTextDirectives(text).problems.map(({ rule }) => rule);
}

describe('readCoverageDirectives', () => {
  it('reads an array literal, an object literal, each inside Object.freeze, and a declaration inside a function', () => {
    assert.deepEqual(readEndStates("// @end-states\nconst A = ['done', `halted`];"), ['done', 'halted']);
    assert.deepEqual(readEndStates("// @end-states\nconst A = { DONE: 'done', [key]: 'halted', 'x y': `failed` };"), ['done', 'halted', 'failed']);
    assert.deepEqual(readEndStates("// @end-states\nconst A = Object.freeze(['done']);"), ['done']);
    assert.deepEqual(readEndStates("// @end-states\nexport const A = Object.freeze({ DONE: 'done' });"), ['done']);
    assert.deepEqual(readEndStates("function f() {\n    // @end-states   of the run\n    const A = ['done'];\n}"), ['done']);
    assert.deepEqual(readProblemRules("// @end-states\nconst A = ['done'];"), []);
  });

  it('gives each end state the offset of its string, and keeps an end state once at its first place, digit runs aside', () => {
    const text = "// @end-states\nconst A = ['round 1', 'done', 'round 22'];\n// @end-states\nconst B = { a: 'done', b: 'halted' };";

    assert.deepEqual(readTextDirectives(text).endStates, [
      { endState: 'round 1', offset: text.indexOf("'round 1'") },
      { endState: 'done', offset: text.indexOf("'done'") },
      { endState: 'halted', offset: text.indexOf("'halted'") },
    ]);
  });

  it('gives end-states-misplaced at the comment for each form it does not take, and reads no end state', () => {
    const cases = {
      'shares its line with code': "foo(); // @end-states\nconst A = ['done'];",
      'above a let': "// @end-states\nlet A = ['done'];",
      'a blank line below': "// @end-states\n\nconst A = ['done'];",
      'on the last line': "const A = ['done'];\n// @end-states",
      'a number': "// @end-states\nconst A = ['done', 3];",
      'an empty string': "// @end-states\nconst A = ['done', ''];",
      'a template literal with an expression': "// @end-states\nconst A = ['done', `round ${n}`];",
      'an object with a spread': "// @end-states\nconst A = { ...B, a: 'done' };",
      'an array with a spread': "// @end-states\nconst A = [...B, 'done'];",
      'an array with a hole': "// @end-states\nconst A = ['done', , 'halted'];",
      'a shorthand property': "// @end-states\nconst A = { done };",
      'a method': "// @end-states\nconst A = { done() {} };",
      'two names in one declaration': "// @end-states\nconst A = ['done'], B = ['halted'];",
      'a pattern': "// @end-states\nconst [A] = ['done'];",
      'a call other than Object.freeze': "// @end-states\nconst A = Object.seal(['done']);",
      'Object.freeze of two arguments': "// @end-states\nconst A = Object.freeze(['done'], 1);",
      'Object.freeze of a name': "// @end-states\nconst A = Object.freeze(B);",
      'a string value': "// @end-states\nconst A = 'done';",
      'an empty array': "// @end-states\nconst A = [];",
      'an empty object inside Object.freeze': "// @end-states\nconst A = Object.freeze({});",
    };

    for (const [name, text] of Object.entries(cases)) {
      const { endStates, problems } = readTextDirectives(text);

      assert.deepEqual(endStates, [], name);
      assert.deepEqual(problems, [{ rule: 'end-states-misplaced', message: END_STATES_MISPLACED, offset: text.indexOf('// @end-states') }], name);
    }
  });

  it('reads no comment that only starts with the word, no block comment and no comment text inside a string', () => {
    const text = "// @end-statesx\nconst A = ['a'];\n/* @end-states */\nconst B = ['b'];\nconst C = `\n// @end-states\n`;\n// @unreachedx\nthrow new Error('x');";

    assert.deepEqual(readTextDirectives(text), { endStates: [], unreachedReasons: new Map(), roleMarks: new Map(), problems: [] });
  });

  it('marks each throw site whose new keyword is on the line below an // @unreached comment, with its reason', () => {
    const text = "if (a) {\n  //   @unreached   no input gives it  \n  throw new Error('x');\n}\n// @unreached\nif (b) throw new Error('y'); else throw new Error('z');";
    const { unreachedReasons, problems } = readTextDirectives(text);

    assert.deepEqual(unreachedReasons, new Map([[3, 'no input gives it'], [6, '']]));
    assert.deepEqual(problems, [{ rule: 'unreached-no-reason', message: 'The // @unreached comment gives no reason', offset: text.indexOf('// @unreached\n') }]);
  });

  it('marks the role of each label property whose key is on the line below an // @unreached comment, with its first comment', () => {
    const text = "const LENSES = [\n  // @unreached a lens label is data\n  { label: 'Security' },\n  {\n    // @unreached keyed by a string\n    'label': `review:${x}`,\n  },\n  // @unreached a later reason\n  { label: 'Security' },\n];";
    const { unreachedReasons, roleMarks, problems } = readTextDirectives(text);

    assert.deepEqual(roleMarks, new Map([
      ['Security', { reason: 'a lens label is data', offset: text.indexOf("'Security'") }],
      ['review', { reason: 'keyed by a string', offset: text.indexOf('`review') }],
    ]));
    assert.deepEqual(unreachedReasons, new Map());
    assert.deepEqual(problems, []);
  });

  it('marks the throw site alone on a line that holds both a throw site and a label property', () => {
    const { unreachedReasons, roleMarks, problems } = readTextDirectives("// @unreached both\nif (a) throw new Error(agent('p', { label: 'x' }));");

    assert.deepEqual(unreachedReasons, new Map([[2, 'both']]));
    assert.deepEqual(roleMarks, new Map());
    assert.deepEqual(problems, []);
  });

  it('gives unreached-misplaced for a comment that shares its line with code or that is above a line with no throw site or role label', () => {
    const cases = {
      'shares its line with code': "foo(); // @unreached reason\nthrow new Error('x');",
      'above a line with no throw site': "// @unreached reason\nfoo();\nthrow new Error('x');",
      'above a throw of no new expression': "// @unreached reason\nthrow error;",
      'above a throw whose constructor is no plain name': "// @unreached reason\nthrow new errors.Fail('x');",
      'on the last line': "throw new Error('x');\n// @unreached reason",
      'above a label property whose value gives no role': "// @unreached reason\nconst a = { label: name };",
      'above a label property whose key starts on the line above': "const a = {\n  label:\n  // @unreached reason\n  'x',\n};",
      'above a computed label key': "// @unreached reason\nconst a = { ['label']: 'x' };",
    };

    for (const [name, text] of Object.entries(cases)) {
      const { unreachedReasons, roleMarks, problems } = readTextDirectives(text);

      assert.deepEqual(unreachedReasons, new Map(), name);
      assert.deepEqual(roleMarks, new Map(), name);
      assert.deepEqual(problems, [{ rule: 'unreached-misplaced', message: UNREACHED_MISPLACED, offset: text.indexOf('// @unreached') }], name);
    }
  });

  it('gives both problems for a misplaced comment with no reason', () => {
    assert.deepEqual(readProblemRules('// @unreached\nfoo();'), ['unreached-no-reason', 'unreached-misplaced']);
  });

  it('places a comment as a throw site is placed, after a byte order mark and at CRLF and lone CR', () => {
    const text = `${BYTE_ORDER_MARK}a();\r\n// @unreached crlf\r\nthrow new Error('x');\rb();\r// @unreached cr\rthrow new Error('y');\r\n// @end-states\r\nconst A = ['done'];\r\n// @unreached role\r\nconst R = { label: 'r' };`;
    const { endStates, unreachedReasons, roleMarks, problems } = readTextDirectives(text);

    assert.deepEqual(unreachedReasons, new Map([[3, 'crlf'], [6, 'cr']]));
    assert.deepEqual(roleMarks, new Map([['r', { reason: 'role', offset: text.indexOf("'r'") }]]));
    assert.deepEqual(endStates.map(({ endState }) => endState), ['done']);
    assert.deepEqual(problems, []);
  });

  it('reads code after a line separator that ends the comment as code on its line', () => {
    assert.deepEqual(readProblemRules("// @end-states const B = 1;\nconst A = ['done'];"), ['end-states-misplaced']);
    assert.deepEqual(readProblemRules("// @unreached r foo();\nthrow new Error('x');"), ['unreached-misplaced']);
  });
});
