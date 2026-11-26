import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkContract } from '../src/check-contract.js';
import { CONTRACT_RULES, CONTRACT_RUNTIME_VERSION, RUNTIME_GLOBAL_NAMES, RUNTIME_INHERITED_GLOBAL_NAMES } from '../src/contract.js';
import { FIXES } from '../src/finding.js';
import { CONTRACT_CASES } from './fixtures/contract/cases.js';

const CASE_FOLDER = fileURLToPath(new URL('./fixtures/contract/cases/', import.meta.url));
// The probe set holds no script for these two rules, so tests/check-contract.test.js covers them.
const RULES_WITHOUT_CASE = new Set(['script-too-large', 'source-too-deep']);
const README = new URL('../README.md', import.meta.url);
const VALIDATE_SECTION_HEADING = '\n## dwfb validate\n';
const RULE_ROW_PATTERN = /^\| `(?<id>[a-z]+(?:-[a-z]+)*)` \|/gm;

describe('contract cases', () => {
  for (const contractCase of CONTRACT_CASES) {
    it(`${contractCase.id} gets ${contractCase.rules.join(', ') || 'no finding'}`, async () => {
      // The runtime reads a script raw, so the text keeps its byte order mark and CRLF.
      const text = await readFile(join(CASE_FOLDER, `${contractCase.id}.js`), 'utf8');
      const rules = [...new Set(checkContract(text, `${contractCase.id}.js`).map((finding) => finding.rule))].sort();
      assert.deepEqual(rules, contractCase.rules);
    });
  }

  it('gives a rule to every script the runtime refused', () => {
    const refusedWithoutRule = CONTRACT_CASES.filter((contractCase) => contractCase.measured === 'refused' && contractCase.rules.length === 0);
    assert.deepEqual(refusedWithoutRule.map((contractCase) => contractCase.id), []);
  });

  it('holds a case for every rule of the contract that a probe script can hold', () => {
    const casedRules = new Set(CONTRACT_CASES.flatMap((contractCase) => contractCase.rules));
    const uncasedRules = CONTRACT_RULES.map((rule) => rule.id).filter((id) => !casedRules.has(id) && !RULES_WITHOUT_CASE.has(id));
    assert.deepEqual(uncasedRules, []);
  });
});

describe('contract rule table', () => {
  it('holds each rule once, measured on the contract version, with a fix', () => {
    const ids = CONTRACT_RULES.map((rule) => rule.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const rule of CONTRACT_RULES) {
      assert.equal(rule.measuredOn, CONTRACT_RUNTIME_VERSION, rule.id);
      assert.ok(Object.hasOwn(FIXES, rule.id), rule.id);
    }
    assert.ok(Object.isFrozen(CONTRACT_RULES) && CONTRACT_RULES.every(Object.isFrozen));
  });

  it('holds the ids of the rule table of the README section on dwfb validate, in its order', async () => {
    const readme = await readFile(README, 'utf8');
    const sectionStart = readme.indexOf(VALIDATE_SECTION_HEADING);
    const sectionEnd = readme.indexOf('\n## ', sectionStart + VALIDATE_SECTION_HEADING.length);
    const section = readme.slice(sectionStart, sectionEnd === -1 ? readme.length : sectionEnd);
    const readmeIds = [...section.matchAll(RULE_ROW_PATTERN)].map((match) => match.groups.id);

    assert.notEqual(sectionStart, -1, `README.md has no line ${VALIDATE_SECTION_HEADING.trim()}`);
    assert.deepEqual(readmeIds, CONTRACT_RULES.map((rule) => rule.id));
  });

  it('lists 76 distinct runtime global names', () => {
    assert.equal(RUNTIME_GLOBAL_NAMES.length, 76);
    assert.equal(new Set(RUNTIME_GLOBAL_NAMES).size, 76);
    assert.ok(Object.isFrozen(RUNTIME_GLOBAL_NAMES));
  });

  it('lists 12 distinct inherited global names, none of them an own global name', () => {
    assert.equal(RUNTIME_INHERITED_GLOBAL_NAMES.length, 12);
    assert.equal(new Set(RUNTIME_INHERITED_GLOBAL_NAMES).size, 12);
    assert.ok(Object.isFrozen(RUNTIME_INHERITED_GLOBAL_NAMES));
    assert.deepEqual(RUNTIME_INHERITED_GLOBAL_NAMES.filter((name) => RUNTIME_GLOBAL_NAMES.includes(name)), []);
  });
});
