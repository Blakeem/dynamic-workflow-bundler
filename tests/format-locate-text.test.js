import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatLocateText } from '../src/format-locate-text.js';

const FINDING = { rule: 'script-differs', message: 'The script differs', fix: 'Build it again', file: 'flow.js', line: 3, column: 1 };
const NO_PLACE = { ok: true, file: null, line: null, column: null, text: null, generated: false, findings: [] };

describe('formatLocateText', () => {
  it('prints the source file, line and column, then the source line', () => {
    assert.equal(formatLocateText({ ...NO_PLACE, file: 'src/a.js', line: 4, column: 3, text: '  run();' }), 'src/a.js:4:3\n  run();\n');
  });

  it('names the source of a line the build adds, and says it has no source line', () => {
    assert.equal(formatLocateText({ ...NO_PLACE, file: 'src/a.js', generated: true }), 'The build adds the line for src/a.js. It has no source line.\n');
    assert.equal(formatLocateText({ ...NO_PLACE, generated: true }), 'The build adds the line. It has no source line.\n');
  });

  it('prints each finding', () => {
    assert.equal(formatLocateText({ ...NO_PLACE, ok: false, findings: [FINDING] }), 'flow.js:3:1 script-differs The script differs. Build it again.\n');
  });
});
