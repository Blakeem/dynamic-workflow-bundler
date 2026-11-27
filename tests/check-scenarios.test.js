import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkScenarios } from '../src/check-scenarios.js';

const FILE_LABEL = 'The scenarios file s.js';
const ROW_FORM = '{ name, args, respond, budget, expect }';

/**
 * @param {unknown} value
 * @param {string} message
 */
function assertUsageError(value, message) {
  assert.throws(() => checkScenarios(value, 's.js'), (error) => error.name === 'UsageError' && error.message === message);
}

describe('checkScenarios', () => {
  it('gives each scenario with its name, its expect defaulted to returned, and the scenario simulate() takes', () => {
    const respond = { review: 'pass' };

    assert.deepEqual(checkScenarios([{ name: 'a', args: { n: 1 }, respond, budget: { total: null } }, { name: 'b', expect: 'threw' }], 's.js'), [
      { name: 'a', expect: 'returned', scenario: { name: 'a', args: { n: 1 }, respond, budget: { total: null } } },
      { name: 'b', expect: 'threw', scenario: { name: 'b' } },
    ]);
  });

  it('names a value that is not a list and an empty list', () => {
    for (const value of [undefined, null, {}, 'a']) assertUsageError(value, `${FILE_LABEL} does not export default a list of scenarios of the form ${ROW_FORM}`);
    assertUsageError([], `${FILE_LABEL} lists no scenario`);
  });

  it('names the scenario of a row that is not an object, an unknown key, a missing name, an unknown expect and a repeated name', () => {
    const label = 'Scenario 2 of the scenarios file s.js';
    const first = { name: 'a' };

    assertUsageError([first, 'b'], `${label} is not an object of the form ${ROW_FORM}`);
    assertUsageError([first, , first], `${label} is not an object of the form ${ROW_FORM}`);
    assertUsageError([first, [{ name: 'b' }]], `${label} is not an object of the form ${ROW_FORM}`);
    assertUsageError([first, { name: 'b', expects: 'threw' }], `${label} has an unknown key expects`);
    for (const name of [undefined, '', 5]) assertUsageError([first, { name }], `${label} needs name, a name that no other scenario of the file has`);
    for (const expect of ['stopped', 'refused', null]) assertUsageError([first, { name: 'b', expect }], `${label} takes expect as 'returned' or 'threw'`);
    assertUsageError([first, { name: 'b' }, { name: 'a' }], 'Scenarios 1 and 3 of the scenarios file s.js are both named "a"');
    assertUsageError([{ name: 'a\n' }, { name: 'a\n' }], 'Scenarios 1 and 2 of the scenarios file s.js are both named "a\\u{000A}"');
  });

  it('names the scenario of each problem simulate() names', () => {
    const label = 'Scenario 1 of the scenarios file s.js is not valid.';

    assertUsageError([{ name: 'a', budget: 3 }], `${label} The scenario budget must be an object of total, spent and spentPerCall`);
    assertUsageError([{ name: 'a', args: { count: 1n } }], `${label} The scenario args hold a BigInt at count, which JSON cannot carry`);
    assertUsageError([{ name: 'a', respond: 'pass' }], `${label} The scenario respond must be an object keyed by label prefix, or a function`);
  });
});
