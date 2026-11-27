import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileScript, wrapScriptBody } from '../src/compile-script.js';

const META = 'export const meta = {};';

describe('wrapScriptBody', () => {
  it('wraps the text after the meta statement as the body of a strict async arrow function', () => {
    assert.equal(wrapScriptBody(`${META}\nreturn 1`, META.length), "(async () => {'use strict';\nreturn 1\n})");
  });
});

describe('compileScript', () => {
  it('compiles a body with a top-level await and return, and runs none of it', () => {
    assert.doesNotThrow(() => compileScript(`${META}\nthrow new Error('ran');\nawait agent();\nreturn 1; // last line`, META.length));
  });

  it('throws the syntax error of a body that does not compile', () => {
    assert.throws(() => compileScript(`${META}\nconst value = ;`, META.length), SyntaxError);
  });

  it('compiles the body as strict code', () => {
    assert.throws(() => compileScript(`${META}\nwith ({}) {}`, META.length), SyntaxError);
  });
});
