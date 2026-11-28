import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBuildText } from '../src/format-build-text.js';

const FINDING = { rule: 'import-meta', message: 'The file holds import.meta', fix: 'Remove it', file: 'src/a.js', line: 2, column: 5 };
const COMMAND = 'dwfb build src/main.js --out flow.js';

/**
 * @param {Partial<import('../src/build.js').BuildResult>} fields
 * @returns {import('../src/build.js').BuildResult}
 */
function createResult(fields) {
  return { ok: true, status: 'written', script: 'é\n', sources: ['src/main.js'], findings: [], ...fields };
}

describe('formatBuildText', () => {
  it('names the count of source files and the bytes of a written script', () => {
    assert.equal(formatBuildText('flow.js', createResult({}), COMMAND), 'Built flow.js from 1 source file, 3 bytes.\n');
    assert.equal(formatBuildText('flow.js', createResult({ sources: ['src/main.js', 'src/a.js'] }), COMMAND), 'Built flow.js from 2 source files, 3 bytes.\n');
  });

  it('prints each finding of a failed build', () => {
    assert.equal(formatBuildText('flow.js', createResult({ ok: false, status: 'failed', script: null, findings: [FINDING] }), COMMAND), 'src/a.js:2:5 import-meta The file holds import.meta. Remove it.\n');
  });

  it('reports each check status, with the command that builds the script again', () => {
    assert.equal(formatBuildText('flow.js', createResult({ status: 'fresh' }), COMMAND), 'flow.js matches its source.\n');
    assert.equal(formatBuildText('flow.js', createResult({ ok: false, status: 'missing' }), COMMAND), `flow.js does not exist. Run ${COMMAND}.\n`);
    const stale = createResult({ ok: false, status: 'stale', firstDifference: { line: 7, file: 'src/a.js', sourceLine: 2 } });
    assert.equal(formatBuildText('flow.js', stale, COMMAND), `flow.js:7 differs from the script the build gives. The line comes from src/a.js:2. Run ${COMMAND}.\n`);
  });
});
