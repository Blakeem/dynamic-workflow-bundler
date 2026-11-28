import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { selectInspectScenario, selectScenarios } from '../src/select-scenarios.js';
import { UsageError } from '../src/usage-error.js';

const FIRST = { name: 'first', expect: 'returned', args: undefined, returns: {} };
const SECOND = { name: 'second', expect: 'returned', args: undefined, returns: {} };

describe('selectScenarios', () => {
  it('gives every scenario with no name, and the scenario of a name', () => {
    assert.deepEqual(selectScenarios([FIRST, SECOND], undefined, 'flow.scenarios.js'), [FIRST, SECOND]);
    assert.deepEqual(selectScenarios([FIRST, SECOND], 'second', 'flow.scenarios.js'), [SECOND]);
  });

  it('refuses a name no scenario has, with each character a terminal does not show as its escape', () => {
    assert.throws(() => selectScenarios([FIRST], 'third\t', 'flow.scenarios.js'), (error) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.message, 'The scenarios file flow.scenarios.js holds no scenario named "third\\u{0009}"');
      return true;
    });
  });
});

describe('selectInspectScenario', () => {
  it('gives the scenario of a name, and with no name the one scenario of the file', () => {
    assert.equal(selectInspectScenario([FIRST, SECOND], 'second', 'flow.scenarios.js'), SECOND);
    assert.equal(selectInspectScenario([FIRST], undefined, 'flow.scenarios.js'), FIRST);
  });

  it('refuses no name for a file of more than one scenario, and names each scenario', () => {
    assert.throws(() => selectInspectScenario([FIRST, SECOND], undefined, 'flow.scenarios.js'), (error) => {
      assert.ok(error instanceof UsageError);
      assert.equal(error.message, 'The scenarios file flow.scenarios.js holds 2 scenarios, so name one with --scenario <name>: "first", "second"');
      return true;
    });
  });

  it('refuses a name no scenario has', () => {
    assert.throws(() => selectInspectScenario([FIRST], 'third', 'flow.scenarios.js'), /holds no scenario named "third"/);
  });
});
