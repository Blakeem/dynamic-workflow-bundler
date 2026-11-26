import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkModuleSyntax, hasModuleSyntax } from '../src/check-module-syntax.js';

describe('checkModuleSyntax', () => {
  it('lists the relative specifiers of the static imports and re-exports, in source order', () => {
    const text = [
      "import a from './a.js';",
      "import 'package';",
      "export * from '../b.mjs';",
      "export { c } from './c.json';",
      'export const d = 1;',
      "await import('./dynamic.js');",
      '',
    ].join('\n');

    assert.deepEqual(checkModuleSyntax(text, 'config.js'), { syntaxError: null, importSpecifiers: ['./a.js', '../b.mjs', './c.json'] });
  });

  it('gives the 1-based line, column and reason of a syntax error', () => {
    assert.deepEqual(checkModuleSyntax('export default {\n  a: 1 b: 2,\n};\n', 'config.mjs'), {
      syntaxError: { line: 2, column: 8, reason: 'Unexpected token' },
      importSpecifiers: [],
    });
  });

  it('parses a .js or .mjs file as an ES module, which refuses a top-level return', () => {
    for (const file of ['a.js', 'a.mjs']) {
      assert.deepEqual(checkModuleSyntax('return 1;\n', file).syntaxError, { line: 1, column: 1, reason: "'return' outside of function" }, file);
    }
  });

  it('gives the place where a .json file breaks the JSON grammar', () => {
    assert.deepEqual(checkModuleSyntax('{\n  "a": 1,\n}\n', 'rows.json'), {
      syntaxError: { line: 3, column: 1, reason: 'Expected a property name in double quotes' },
      importSpecifiers: [],
    });
    assert.deepEqual(checkModuleSyntax('{ "a": 1 }\n', 'rows.json'), { syntaxError: null, importSpecifiers: [] });
  });

  it('gives no syntax error and no import for a file of another ending', () => {
    for (const file of ['prompt.md', 'rows.cjs']) {
      assert.deepEqual(checkModuleSyntax('not { code', file), { syntaxError: null, importSpecifiers: [] }, file);
    }
  });
});

describe('hasModuleSyntax', () => {
  it('is true for text that parses only as an ES module', () => {
    for (const text of ["import './a.js';\n", 'export default {};\n', 'const url = import.meta.url;\n', 'await Promise.resolve();\n']) {
      assert.equal(hasModuleSyntax(text), true, text);
    }
  });

  it('is false for CommonJS text, text that parses as neither and text that parses as both', () => {
    for (const text of ['module.exports = {};\n', 'return 1;\n', 'export default { a: };\n', 'const a = 1;\n']) {
      assert.equal(hasModuleSyntax(text), false, text);
    }
  });
});
