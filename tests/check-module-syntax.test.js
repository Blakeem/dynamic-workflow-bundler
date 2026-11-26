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

  it('parses a .js file that loads as CommonJS as CommonJS, and lists no import of it', () => {
    assert.deepEqual(checkModuleSyntax("var package = require('./a.js');\nif (!package) return;\n", 'a.js', false), { syntaxError: null, importSpecifiers: [] });
    assert.deepEqual(checkModuleSyntax("import './a.js';\n", 'a.js', false).syntaxError, { line: 1, column: 1, reason: "'import' and 'export' may appear only with 'sourceType: module'" });
    assert.deepEqual(checkModuleSyntax("import './a.js';\n", 'a.mjs', false), { syntaxError: null, importSpecifiers: ['./a.js'] });
  });

  it('allows a top-level new.target in a CommonJS file, as the function Node runs it in does', () => {
    assert.deepEqual(checkModuleSyntax('if (new.target) throw 1;\nmodule.exports = 1;\n', 'a.js', false), { syntaxError: null, importSpecifiers: [] });
    assert.equal(checkModuleSyntax('if (new.target) throw 1;\n', 'a.mjs').syntaxError.reason, "'new.target' can only be used in functions and class static block");
  });

  it('parses a .cjs file as CommonJS whatever module type it is given', () => {
    assert.deepEqual(checkModuleSyntax('if (true) return;\n', 'a.cjs'), { syntaxError: null, importSpecifiers: [] });
    assert.deepEqual(checkModuleSyntax('module.exports = ;\n', 'a.cjs').syntaxError, { line: 1, column: 18, reason: 'Unexpected token' });
  });

  it('gives the place where a .json file breaks the JSON grammar', () => {
    assert.deepEqual(checkModuleSyntax('{\n  "a": 1,\n}\n', 'rows.json'), {
      syntaxError: { line: 3, column: 1, reason: 'Expected a property name in double quotes' },
      importSpecifiers: [],
    });
    assert.deepEqual(checkModuleSyntax('{ "a": 1 }\n', 'rows.json'), { syntaxError: null, importSpecifiers: [] });
  });

  it('gives no syntax error and no import for a file of another ending', () => {
    for (const file of ['prompt.md', 'rows.txt']) {
      assert.deepEqual(checkModuleSyntax('not { code', file), { syntaxError: null, importSpecifiers: [] }, file);
    }
  });
});

describe('hasModuleSyntax', () => {
  it('is true for text that parses only as an ES module, and for text whose CommonJS parse fails on module syntax', () => {
    const texts = ["import './a.js';\n", 'export default {};\n', 'const url = import.meta.url;\n', 'await Promise.resolve();\n', 'export default { a: };\n', 'const url = import.meta.url;\nlet let = 1;\n', "if (new.target) {}\nimport './a.js';\nlet let = 1;\n", 'if (true) {\n  export const q = 1;\n}\nvar z = ;\n'];
    for (const text of texts) {
      assert.equal(hasModuleSyntax(text), true, text);
    }
  });

  it('is false for CommonJS text, text that parses as both and text whose CommonJS parse fails elsewhere', () => {
    for (const text of ['module.exports = {};\n', 'return 1;\n', 'const a = 1;\n', "const = 1;\nimport './a.js';\n"]) {
      assert.equal(hasModuleSyntax(text), false, text);
    }
  });
});
