import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convertRuntimePosition } from '../src/convert-runtime-position.js';
import { UsageError } from '../src/usage-error.js';

const META = "export const meta = {\n  name: 'probe',\n  description: 'Probe',\n};";

describe('convertRuntimePosition', () => {
  it('gives the probe\'s script lines for its runtime lines, with code first on line 6 after a blank line 5', () => {
    const script = `${META}\n\n${'x;\n'.repeat(10)}`;

    assert.deepEqual(convertRuntimePosition(script, META.length, 3, 14), { line: 7, column: 14 });
    assert.deepEqual(convertRuntimePosition(script, META.length, 5, 9), { line: 9, column: 9 });
    assert.deepEqual(convertRuntimePosition(script, META.length, 8, 14), { line: 12, column: 14 });
  });

  it('gives script line 6 for runtime line 3 when the meta statement ends on line 4 and the banner is line 5', () => {
    const script = `${META}\n// Built by dynamic-workflow-bundler from entry.js. Edit the source, not this file.\nconst a = 1;\nreturn a;\n`;

    assert.deepEqual(convertRuntimePosition(script, META.length, 3, 7), { line: 6, column: 7 });
  });

  it('adds the text that the runtime drops before the first character of code to a column of runtime line 2', () => {
    const script = `${META} ;\n  \t  return 1;\n`;

    assert.deepEqual(convertRuntimePosition(script, META.length, 2, 1), { line: 5, column: 6 });
    assert.deepEqual(convertRuntimePosition(script, META.length, 2, 8), { line: 5, column: 13 });
  });

  it('keeps the column on the meta statement\'s last line when code follows it there', () => {
    const script = 'export const meta = {}; return 1;\n';

    assert.deepEqual(convertRuntimePosition(script, 23, 2, 1), { line: 1, column: 25 });
  });

  it('rejects a runtime line below U+2028 or U+2029, and converts one above it', () => {
    for (const terminator of ['\u2028', '\u2029']) {
      const script = `${META}\nconst a = 'x${terminator}y';\nreturn a;\n`;
      assert.deepEqual(convertRuntimePosition(script, META.length, 2, 12), { line: 5, column: 12 });
      assert.throws(() => convertRuntimePosition(script, META.length, 3, 1), { name: 'UsageError', message: /holds U\+2028 or U\+2029 above line 6/ });
    }
  });

  it('gives a line past the script\'s end for the caller to reject, even below U+2028', () => {
    const script = `${META}\nconst a = 'x\u2028y';\nreturn a;\n`;

    assert.deepEqual(convertRuntimePosition(script, META.length, 4, 1), { line: 7, column: 1 });
    assert.deepEqual(convertRuntimePosition(script, META.length, 50, 1), { line: 53, column: 1 });
  });

  it('rejects runtime line 1 and a script with nothing after its meta statement', () => {
    assert.throws(() => convertRuntimePosition(`${META}\nreturn 1;\n`, META.length, 1, 1), { name: 'UsageError', message: /runtime line 1 holds no line of the script/ });
    assert.throws(() => convertRuntimePosition(`${META}\n;\n`, META.length, 2, 1), (error) => error instanceof UsageError && /nothing after its meta statement/.test(error.message));
  });
});
