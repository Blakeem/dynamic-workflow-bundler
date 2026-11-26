/**
 * @typedef {object} ParityCase
 * @property {string} name
 * @property {Record<string, string>} files The source files by path, with a `main.js` whose default export is
 *   the case's result.
 * @property {'equal' | 'refused' | 'deviation'} expected
 * @property {string} [rule] For a `refused` case, the rule id of the finding the build gives.
 * @property {string} [difference] For a `deviation` case, how the built script differs from ES modules.
 * @property {Settled} [actual] For a `deviation` case, what the built script gives.
 */

/** @typedef {{ value: unknown } | { thrown: string }} Settled A result after a JSON round trip, or the constructor name of what it threw, or its [object Type] tag when it has no constructor, such as null. */

/**
 * @param {string} imports
 * @param {string} expression
 * @returns {string} A main.js that imports and exports the expression as its default.
 */
const formatMain = (imports, expression) => `${imports}\nexport default ${expression};\n`;

/** @type {ParityCase[]} */
export const PARITY_CASES = [
  { name: 'default: number', expected: 'equal', files: { 'main.js': 'export default 42;\n' } },
  { name: 'default: sequence in parens', expected: 'equal', files: { 'main.js': 'export default (1, 2);\n' } },
  { name: 'default: anonymous class name', expected: 'equal', files: { 'a.js': 'export default class {}\n', 'main.js': formatMain("import C from './a.js';", 'C.name') } },
  { name: 'default: anonymous function name', expected: 'equal', files: { 'a.js': 'export default function () {}\n', 'main.js': formatMain("import f from './a.js';", 'f.name') } },
  { name: 'default: parenthesized function name', expected: 'equal', files: { 'a.js': 'export default (function () {});\n', 'main.js': formatMain("import f from './a.js';", 'f.name') } },
  { name: 'default: arrow name', expected: 'equal', files: { 'a.js': 'export default () => 1;\n', 'main.js': formatMain("import f from './a.js';", 'f.name') } },
  { name: 'default: named class', expected: 'equal', files: { 'a.js': 'export default class Foo { static v = 3 }\n', 'main.js': formatMain("import C from './a.js';", '[C.name, C.v]') } },
  { name: 'default: hoisted function used above', expected: 'equal', files: { 'a.js': 'export const early = helper();\nexport default function helper() { return 7; }\n', 'main.js': formatMain("import h, { early } from './a.js';", '[h(), early]') } },
  { name: 'default: async function', expected: 'equal', files: { 'a.js': 'export default async function () { return 5; }\n', 'main.js': formatMain("import f from './a.js';", 'f()') } },
  { name: 'default: generator', expected: 'equal', files: { 'a.js': 'export default function* () { yield 1; yield 2; }\n', 'main.js': formatMain("import g from './a.js';", '[...g()]') } },
  { name: 'default: object literal no semicolon then paren line', expected: 'equal', files: { 'a.js': 'const log = []\nexport default { a: 1 }\n;(() => log.push(1))()\nexport { log }\n', 'main.js': formatMain("import o, { log } from './a.js';", '[o, log]') } },
  { name: 'default: expression then bracket line', expected: 'equal', files: { 'a.js': 'const x = [5]\nexport default x\n[0]\n', 'main.js': formatMain("import v from './a.js';", 'v') } },
  { name: 'default: as list name', expected: 'equal', files: { 'a.js': 'const a = 9;\nexport { a as default };\n', 'main.js': formatMain("import v from './a.js';", 'v') } },
  { name: 'import: default as', expected: 'equal', files: { 'a.js': 'export default 3;\nexport const b = 4;\n', 'main.js': formatMain("import { default as d, b } from './a.js';", '[d, b]') } },
  { name: 'import: default and namespace', expected: 'equal', files: { 'a.js': 'export default 3;\nexport const b = 4;\n', 'main.js': formatMain("import d, * as ns from './a.js';", '[d, ns.b, ns.default]') } },
  { name: 'export: string name', expected: 'equal', files: { 'a.js': 'const a = 1;\nexport { a as "a-b" };\n', 'main.js': formatMain("import { \"a-b\" as ab } from './a.js';", 'ab') } },
  { name: 'export: __proto__ name', expected: 'equal', files: { 'a.js': 'const a = 1;\nexport { a as __proto__ };\n', 'main.js': formatMain("import * as ns from './a.js';", '[Object.keys(ns), Object.getPrototypeOf(ns)]') } },
  { name: 'export: const __proto__', expected: 'equal', files: { 'a.js': 'export const __proto__ = 5;\n', 'main.js': formatMain("import * as ns from './a.js';", '[Object.keys(ns), Object.getPrototypeOf(ns)]') } },
  { name: 'export: destructuring', expected: 'equal', files: { 'a.js': 'export const { a, b: [c, ...d], ...e } = { a: 1, b: [2, 3, 4], f: 5 };\n', 'main.js': formatMain("import { a, c, d, e } from './a.js';", '[a, c, d, e]') } },
  { name: 'export: two declarators', expected: 'equal', files: { 'a.js': 'export const a = 1, b = a + 1;\n', 'main.js': formatMain("import { a, b } from './a.js';", '[a, b]') } },
  { name: 'export: var', expected: 'refused', rule: 'export-not-constant', files: { 'a.js': 'export var v = 1;\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'export: let never reassigned', expected: 'refused', rule: 'export-not-constant', files: { 'a.js': 'export let v = 1;\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'export: list of a let never reassigned', expected: 'equal', files: { 'a.js': 'let v = 1;\nexport { v };\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'export: function reassigned later', expected: 'refused', rule: 'export-not-constant', files: { 'a.js': 'export function f() { return 1; }\nexport function swap() { f = () => 2; }\n', 'main.js': formatMain("import { f, swap } from './a.js';", '(swap(), f())') } },
  { name: 'export: class with static block', expected: 'equal', files: { 'a.js': 'export class C { static n; static { C.n = 4; } }\n', 'main.js': formatMain("import { C } from './a.js';", 'C.n') } },
  { name: 'export: same name twice in list', expected: 'equal', files: { 'a.js': 'const a = 1;\nexport { a, a as b };\n', 'main.js': formatMain("import { a, b } from './a.js';", '[a, b]') } },
  { name: 'namespace: key order and shape', expected: 'equal', files: { 'a.js': 'export const b = 1;\nexport const a = 2;\nexport default 3;\n', 'main.js': formatMain("import * as ns from './a.js';", "[Object.keys(ns), 'a' in ns, Object.getPrototypeOf(ns), ns[Symbol.toStringTag], Object.isExtensible(ns)]") } },
  { name: 'namespace: write throws', expected: 'equal', files: { 'a.js': 'export const a = 2;\n', 'main.js': formatMain("import * as ns from './a.js';", "(() => { try { ns.a = 5; return 'no throw'; } catch (e) { return e.name; } })()") } },
  {
    name: 'namespace: descriptor',
    expected: 'deviation',
    difference: 'A namespace import gives a frozen object, so the descriptor of each of its members reports writable: false, where an ES module namespace reports writable: true.',
    actual: { value: { value: 2, writable: false, enumerable: true, configurable: false } },
    files: { 'a.js': 'export const a = 2;\n', 'main.js': formatMain("import * as ns from './a.js';", "Object.getOwnPropertyDescriptor(ns, 'a')") },
  },
  { name: 'namespace: thenable export awaited', expected: 'equal', files: { 'a.js': 'export function then(resolve) { resolve(11); }\n', 'main.js': formatMain("import * as ns from './a.js';", 'Promise.resolve(ns)') } },
  {
    name: 'order: diamond',
    expected: 'equal',
    files: {
      'log.js': 'export const log = [];\n',
      'b.js': "import { log } from './log.js';\nimport './c.js';\nlog.push('b');\n",
      'c.js': "import { log } from './log.js';\nlog.push('c');\n",
      'd.js': "import { log } from './log.js';\nlog.push('d');\n",
      'main.js': "import { log } from './log.js';\nlog.push('main');\nimport './d.js';\nimport './b.js';\nimport './c.js';\nexport default log;\n",
    },
  },
  { name: 'scope: same top-level names in two modules', expected: 'equal', files: { 'a.js': 'const helper = 1;\nexport const a = helper;\n', 'b.js': 'const helper = 2;\nexport const b = helper;\n', 'main.js': formatMain("import { a } from './a.js';\nimport { b } from './b.js';\nconst helper = 3;", '[a, b, helper]') } },
  { name: 'scope: same basename in two folders', expected: 'equal', files: { 'x/util.js': 'export const v = 1;\n', 'y/util.js': 'export const v = 2;\n', 'main.js': formatMain("import { v as a } from './x/util.js';\nimport { v as b } from './y/util.js';", '[a, b]') } },
  { name: 'scope: module declares a runtime global name', expected: 'equal', files: { 'a.js': 'const agent = 5;\nexport const v = agent;\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'scope: top-level var and block function', expected: 'equal', files: { 'a.js': 'var n = 1;\n{ function inner() { return n + 1; } n = inner(); }\nexport const v = n;\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'syntax: hashbang in module', expected: 'refused', rule: 'syntax-error', files: { 'a.js': '#!/usr/bin/env node\nexport const v = 1;\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'syntax: use strict directive', expected: 'equal', files: { 'a.js': "'use strict';\nexport const v = (function () { return this; })();\n", 'main.js': formatMain("import { v } from './a.js';", 'v === undefined') } },
  { name: 'syntax: no semicolons with hazards', expected: 'equal', files: { 'a.js': "const log = []\nimport { tag } from './t.js'\n;[1, 2].forEach((n) => log.push(n))\nexport { log }\n`x`.length\n", 't.js': 'export const tag = 1\n', 'main.js': formatMain("import { log } from './a.js';", 'log') } },
  { name: 'syntax: import between statements no semicolons', expected: 'equal', files: { 'a.js': "const f = () => 'f'\nimport './t.js'\n(function () {})()\nexport const v = f()\n", 't.js': 'export const tag = 1\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'syntax: BOM and CRLF module', expected: 'equal', files: { 'a.js': '\uFEFFexport const v = `a\r\nb`;\r\nexport const w = "c\\\r\nd";\r\n', 'main.js': formatMain("import { v, w } from './a.js';", '[v, w]') } },
  { name: 'syntax: line separator in string', expected: 'equal', files: { 'a.js': 'export const v = "a\u2028b";\n', 'main.js': formatMain("import { v } from './a.js';", 'v.length') } },
  { name: 'syntax: unicode escape identifier', expected: 'equal', files: { 'a.js': 'export const \\u0061bc = 1;\n', 'main.js': formatMain("import { abc } from './a.js';", 'abc') } },
  { name: 'syntax: regex with slashes and template nesting', expected: 'equal', files: { 'a.js': 'export const v = `${/[/`]/.test("`") ? `in${1}` : "no"}`;\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'syntax: import attribute json in module', expected: 'equal', files: { 'a.json': '{ "k": [1, 2] }\n', 'main.js': formatMain("import data from './a.json' with { type: 'json' };", 'data') } },
  { name: 'binding: import used above its statement', expected: 'equal', files: { 'a.js': 'export const v = 6;\n', 'main.js': "const early = v;\nimport { v } from './a.js';\nexport default early;\n" } },
  { name: 'binding: assign to import throws', expected: 'equal', files: { 'a.js': 'export const v = 6;\n', 'main.js': "import { v } from './a.js';\nlet out;\ntry { v = 7; out = 'no throw'; } catch (e) { out = e.name; }\nexport default out;\n" } },
  { name: 'binding: typeof this at top level', expected: 'refused', rule: 'module-top-level-this', files: { 'a.js': 'export const v = typeof this;\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'binding: typeof arguments at top level', expected: 'refused', rule: 'module-top-level-arguments', files: { 'a.js': 'export const v = typeof arguments;\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'binding: await at top level', expected: 'refused', rule: 'module-top-level-await', files: { 'a.js': 'export const v = await Promise.resolve(8);\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'binding: module reads undeclared global', expected: 'equal', files: { 'a.js': 'export const v = typeof someUndeclaredName;\n', 'main.js': formatMain("import { v } from './a.js';", 'v') } },
  { name: 'binding: export default expression reads later const', expected: 'equal', files: { 'a.js': 'export default () => later;\nconst later = 3;\n', 'main.js': formatMain("import f from './a.js';", 'f()') } },
  { name: 'binding: import same module twice', expected: 'equal', files: { 'a.js': 'let n = 0;\nexport const next = () => ++n;\n', 'main.js': formatMain("import { next } from './a.js';\nimport { next as again } from './a.js';", '[next(), again()]') } },
  { name: 'binding: class private and accessor exports', expected: 'equal', files: { 'a.js': 'export class C { #v = 2; get v() { return this.#v; } static of() { return new C(); } }\n', 'main.js': formatMain("import { C } from './a.js';", 'C.of().v') } },
];
