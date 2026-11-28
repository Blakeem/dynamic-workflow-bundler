import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPromptBudgets, isPromptBudget } from '../src/prompt-budget.js';

/**
 * @param {unknown} value
 * @param {string} message
 */
function assertUsageError(value, message) {
  assert.throws(() => checkPromptBudgets(value, 'Workflow 1'), (error) => error.name === 'UsageError' && error.message === message);
}

describe('isPromptBudget', () => {
  it('is true for a whole number of 1 or more', () => {
    const promptBudgets = [1, 2, 4000, Number.MAX_SAFE_INTEGER, 1e21];

    assert.deepEqual(promptBudgets.filter((value) => !isPromptBudget(value)), []);
  });

  it('is false for 0, a negative or fractional number, a number that is not finite and every other type', () => {
    const others = [0, -0, -1, 1.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '4', 4n, true, null, undefined, [4], { value: 4 }];

    assert.deepEqual(others.filter(isPromptBudget), []);
  });
});

describe('checkPromptBudgets', () => {
  it('passes an object whose every value is a prompt budget, and an empty object', () => {
    assert.doesNotThrow(() => checkPromptBudgets({ review: 4000, verify: 1 }, 'Workflow 1'));
    assert.doesNotThrow(() => checkPromptBudgets({}, 'Workflow 1'));
  });

  it('names the shape of promptBudgets for a value that is not an object', () => {
    for (const value of [null, undefined, 5, 'review', [4000]]) assertUsageError(value, 'Workflow 1 takes promptBudgets as an object that gives a role a whole number of 1 or more');
  });

  it('names the first role whose value is not a prompt budget, with its hidden characters shown', () => {
    assertUsageError({ check: 9, 'review\n': 0, verify: -1 }, 'Workflow 1 takes the prompt budget of the role "review\\u{000A}" as a whole number of 1 or more');
  });
});
