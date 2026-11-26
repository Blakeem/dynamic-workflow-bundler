import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'acorn';
import { findExportAssignments } from '../src/find-export-assignments.js';

/**
 * @param {string} text
 * @param {string[]} exportedNames
 * @returns {number[]} The line of each assignment found.
 */
function findAssignedLines(text, exportedNames) {
  const program = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  return findExportAssignments(program, new Set(exportedNames)).map((identifier) => identifier.loc.start.line);
}

describe('findExportAssignments', () => {
  it('finds assignment, update, destructuring and loop targets of an exported name', () => {
    const text = [
      'let total = 0;',
      'total = 1;',
      'total++;',
      '[total] = [2];',
      '({ value: total } = { value: 3 });',
      'for (total of [4]) {}',
      'function raise() { total += 1; }',
      'const raiseLater = () => { if (true) { total -= 1; } };',
    ].join('\n');

    assert.deepEqual(findAssignedLines(text, ['total']), [2, 3, 4, 5, 6, 7, 8]);
  });

  it('skips a name that an inner scope declares again', () => {
    const text = [
      'let total = 0;',
      'function byParameter(total) { total = 1; }',
      'function byVar() { if (true) { var total; } total = 2; }',
      '{ let total; total = 3; }',
      'for (let total = 0; total < 1; total++) {}',
      'try {} catch (total) { total = 4; }',
      'const byName = function total() { total = 5; };',
      'switch (1) { case 1: let total; total = 6; }',
      'class Holder { static { var total; total = 7; } }',
      'function byInnerFunction() { function total() {} total = 8; }',
      'const other = { total: 9 };',
      'other.total = 10;',
    ].join('\n');

    assert.deepEqual(findAssignedLines(text, ['total']), []);
  });

  it('finds an assignment in a parameter default, where body declarations do not reach', () => {
    const text = ['let total = 0;', 'function reset(value = (total = 1)) { var total; }'].join('\n');

    assert.deepEqual(findAssignedLines(text, ['total']), [2]);
  });

  it('ignores names that are not exported', () => {
    assert.deepEqual(findAssignedLines('let local = 0;\nlocal = 1;', ['other']), []);
  });
});
