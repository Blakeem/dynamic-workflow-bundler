import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { checkConfig } from '../src/check-config.js';

const CONFIG_FILE = resolve('project', 'dwfb.config.js');
const PROJECT_FOLDER = resolve('project');

/** @param {unknown} value */
function check(value) {
  return checkConfig(value, CONFIG_FILE, 'dwfb.config.js');
}

/**
 * @param {unknown} value
 * @param {string} message
 */
function assertUsageError(value, message) {
  assert.throws(() => check(value), (error) => error.name === 'UsageError' && error.message === message);
}

describe('checkConfig', () => {
  it('resolves each path against the config file folder, defaults banner and validate to true and scenarios, map, snapshot and promptBudgets to null', () => {
    const promptBudgets = { review: 4000, 'verify r': 1 };
    const config = check({
      workflows: [
        { entry: 'a/entry.js', out: '../dist/a.js' },
        { entry: 'b.js', out: 'b.out.js', banner: false, validate: false, scenarios: '../b/scenarios.js', map: 'docs/b.flow-map.md', snapshot: 'docs/b.prompts.md', promptBudgets },
      ],
    });

    assert.deepEqual(config, {
      workflows: [
        { entry: join(PROJECT_FOLDER, 'a', 'entry.js'), out: resolve(PROJECT_FOLDER, '..', 'dist', 'a.js'), banner: true, validate: true, scenarios: null, map: null, snapshot: null, promptBudgets: null },
        {
          entry: join(PROJECT_FOLDER, 'b.js'),
          out: join(PROJECT_FOLDER, 'b.out.js'),
          banner: false,
          validate: false,
          scenarios: resolve(PROJECT_FOLDER, '..', 'b', 'scenarios.js'),
          map: join(PROJECT_FOLDER, 'docs', 'b.flow-map.md'),
          snapshot: join(PROJECT_FOLDER, 'docs', 'b.prompts.md'),
          promptBudgets: { review: 4000, 'verify r': 1 },
        },
      ],
    });
    promptBudgets.review = 1;
    assert.equal(config.workflows[1].promptBudgets?.review, 4000);
  });

  it('names a snapshot of the wrong type, a snapshot that names a folder and a snapshot with no scenarios', () => {
    const label = 'Workflow 1 of the config file dwfb.config.js';
    const row = { entry: 'a.js', out: 'a.out.js', scenarios: 's.js' };

    for (const snapshot of ['', 5, null]) assertUsageError({ workflows: [{ ...row, snapshot }] }, `${label} takes snapshot as the path of a prompt snapshot file`);
    assertUsageError({ workflows: [{ ...row, snapshot: 'docs/' }] }, `${label} gives the snapshot docs/, which names a folder`);
    assertUsageError({ workflows: [{ ...row, snapshot: 'docs/..' }] }, `${label} gives the snapshot docs/.., which names a folder`);
    assertUsageError({ workflows: [{ entry: 'a.js', out: 'a.out.js', snapshot: 'a.md' }] }, `${label} gives snapshot and no scenarios, so name the scenarios file that the prompt snapshot is drawn from`);
  });

  it('names promptBudgets of another shape, the role of a prompt budget of another shape and promptBudgets with no snapshot', () => {
    const label = 'Workflow 1 of the config file dwfb.config.js';
    const row = { entry: 'a.js', out: 'a.out.js', scenarios: 's.js', snapshot: 'a.md' };
    const refusedShapes = [null, 5, 'review', [4000], new Map()];
    const refusedPromptBudgets = [0, 1.5, '4000', Number.NaN, Number.POSITIVE_INFINITY, -1];

    for (const promptBudgets of refusedShapes) assertUsageError({ workflows: [{ ...row, promptBudgets }] }, `${label} takes promptBudgets as an object that gives a role a whole number of 1 or more`);
    for (const promptBudget of refusedPromptBudgets) {
      assertUsageError({ workflows: [{ ...row, promptBudgets: { check: 9, 'review\n': promptBudget } }] }, `${label} takes the prompt budget of the role "review\\u{000A}" as a whole number of 1 or more`);
    }
    assertUsageError({ workflows: [{ entry: 'a.js', out: 'a.out.js', scenarios: 's.js', promptBudgets: { review: 1 } }] }, `${label} gives promptBudgets and no snapshot, so name the prompt snapshot file that the prompt budgets are checked in`);
    assert.deepEqual(check({ workflows: [{ ...row, promptBudgets: {} }] }).workflows[0].promptBudgets, {});
  });

  it('names a snapshot that names the entry, out, scenarios, map or snapshot of its own or another workflow, and a map that names a snapshot, by any spelling or letter case', () => {
    const first = { entry: 'a.js', out: 'a.out.js', scenarios: 'a.scenarios.js', snapshot: 'a.prompts.md' };
    const cases = [
      [[{ ...first, snapshot: 'a.js' }], 'Workflow 1 of the config file dwfb.config.js writes the snapshot a.js, which names the entry a.js of workflow 1'],
      [[{ ...first, snapshot: './a.out.js' }], 'Workflow 1 of the config file dwfb.config.js writes the snapshot ./a.out.js, which names the out file a.out.js of workflow 1'],
      [[{ ...first, snapshot: 'x/../a.scenarios.js' }], 'Workflow 1 of the config file dwfb.config.js writes the snapshot x/../a.scenarios.js, which names the scenarios file a.scenarios.js of workflow 1'],
      [[{ ...first, map: 'a.md', snapshot: 'a.md' }], 'Workflow 1 of the config file dwfb.config.js writes the map a.md, which names the snapshot a.md of workflow 1'],
      [[{ ...first, map: 'a.md', snapshot: 'A.md' }], 'Workflow 1 of the config file dwfb.config.js writes the map a.md, which names the snapshot A.md of workflow 1 where file names ignore letter case'],
      [[first, { entry: 'b.js', out: 'b.out.js', scenarios: 'b.scenarios.js', snapshot: 'a.prompts.md' }], 'Workflow 1 of the config file dwfb.config.js writes the snapshot a.prompts.md, which names the snapshot a.prompts.md of workflow 2'],
      [[first, { entry: 'b.js', out: 'b.out.js', scenarios: 'b.scenarios.js', map: './A.prompts.md' }], 'Workflow 1 of the config file dwfb.config.js writes the snapshot a.prompts.md, which names the map ./A.prompts.md of workflow 2 where file names ignore letter case'],
      [[{ entry: 'b.js', out: 'b.out.js', scenarios: 'b.scenarios.js', map: 'a.prompts.md' }, first], 'Workflow 1 of the config file dwfb.config.js writes the map a.prompts.md, which names the snapshot a.prompts.md of workflow 2'],
      [[first, { entry: 'B.js', out: 'b.out.js' }, { entry: 'c.js', out: 'c.out.js', scenarios: 'c.scenarios.js', snapshot: 'b.js' }], 'Workflow 3 of the config file dwfb.config.js writes the snapshot b.js, which names the entry B.js of workflow 2 where file names ignore letter case'],
    ];

    for (const [workflows, message] of cases) assertUsageError({ workflows }, message);
  });

  it('names a map of the wrong type, a map that names a folder and a map with no scenarios', () => {
    const label = 'Workflow 1 of the config file dwfb.config.js';
    const row = { entry: 'a.js', out: 'a.out.js', scenarios: 's.js' };

    for (const map of ['', 5, null]) assertUsageError({ workflows: [{ ...row, map }] }, `${label} takes map as the path of a flow map file`);
    assertUsageError({ workflows: [{ ...row, map: 'docs/' }] }, `${label} gives the map docs/, which names a folder`);
    assertUsageError({ workflows: [{ ...row, map: 'docs/..' }] }, `${label} gives the map docs/.., which names a folder`);
    assertUsageError({ workflows: [{ entry: 'a.js', out: 'a.out.js', map: 'a.md' }] }, `${label} gives map and no scenarios, so name the scenarios file that the flow map is drawn from`);
  });

  it('names a map that names the entry, out, scenarios or map of its own or another workflow, by any spelling or letter case', () => {
    const first = { entry: 'a.js', out: 'a.out.js', scenarios: 'a.scenarios.js', map: 'a.md' };
    const cases = [
      [[{ ...first, map: 'a.js' }], 'Workflow 1 of the config file dwfb.config.js writes the map a.js, which names the entry a.js of workflow 1'],
      [[{ ...first, map: './a.out.js' }], 'Workflow 1 of the config file dwfb.config.js writes the map ./a.out.js, which names the out file a.out.js of workflow 1'],
      [[{ ...first, map: 'x/../a.scenarios.js' }], 'Workflow 1 of the config file dwfb.config.js writes the map x/../a.scenarios.js, which names the scenarios file a.scenarios.js of workflow 1'],
      [[first, { entry: 'b.js', out: 'b.out.js', scenarios: 'b.scenarios.js', map: 'a.md' }], 'Workflow 1 of the config file dwfb.config.js writes the map a.md, which names the map a.md of workflow 2'],
      [[first, { entry: 'B.js', out: 'b.out.js' }, { entry: 'c.js', out: 'c.out.js', scenarios: 'c.scenarios.js', map: 'b.js' }], 'Workflow 3 of the config file dwfb.config.js writes the map b.js, which names the entry B.js of workflow 2 where file names ignore letter case'],
      [[{ ...first, map: 'A.out.js' }, { entry: 'b.js', out: 'A.out.js' }], 'Workflows 1 and 2 of the config file dwfb.config.js write a.out.js and A.out.js, which name one file where file names ignore letter case'],
      [[{ ...first, map: 'S.js' }, { entry: 'b.js', out: 'b.out.js', scenarios: 's.js' }, { entry: 'c.js', out: 'c.out.js', scenarios: 'S.js' }], 'Workflow 1 of the config file dwfb.config.js writes the map S.js, which names the scenarios file S.js of workflow 3'],
    ];

    for (const [workflows, message] of cases) assertUsageError({ workflows }, message);
  });

  it('names an out, a map or a snapshot that names the config file, by any spelling or letter case', () => {
    const row = { entry: 'a.js', out: 'a.out.js', scenarios: 'a.scenarios.js' };
    const cases = [
      [{ ...row, out: 'dwfb.config.js' }, 'Workflow 1 of the config file dwfb.config.js writes dwfb.config.js, which names the config file'],
      [{ ...row, out: 'x/../DWFB.config.js' }, 'Workflow 1 of the config file dwfb.config.js writes x/../DWFB.config.js, which names the config file where file names ignore letter case'],
      [{ ...row, map: './dwfb.config.js' }, 'Workflow 1 of the config file dwfb.config.js writes the map ./dwfb.config.js, which names the config file'],
      [{ ...row, map: 'Dwfb.Config.js' }, 'Workflow 1 of the config file dwfb.config.js writes the map Dwfb.Config.js, which names the config file where file names ignore letter case'],
      [{ ...row, snapshot: './dwfb.config.js' }, 'Workflow 1 of the config file dwfb.config.js writes the snapshot ./dwfb.config.js, which names the config file'],
      [{ ...row, snapshot: 'x/../DWFB.Config.js' }, 'Workflow 1 of the config file dwfb.config.js writes the snapshot x/../DWFB.Config.js, which names the config file where file names ignore letter case'],
    ];

    for (const [workflow, message] of cases) assertUsageError({ workflows: [workflow] }, message);
    assertUsageError({ workflows: [{ entry: 'b.js', out: 'b.out.js' }, { ...row, out: 'dwfb.config.js' }] }, 'Workflow 2 of the config file dwfb.config.js writes dwfb.config.js, which names the config file');
  });

  it('names a config file that lists no workflow', () => {
    assertUsageError({ workflows: [] }, 'The config file dwfb.config.js lists no workflow');
  });

  it('names a value of another shape, an unknown key and a missing workflows list', () => {
    const shape = 'The config file dwfb.config.js does not export default an object of the form { workflows: [...] }';
    for (const value of [undefined, null, 'workflows', [], 1]) assertUsageError(value, shape);
    assertUsageError({ workflows: [], watch: true }, 'The config file dwfb.config.js has an unknown key watch');
    assertUsageError({ workflow: [] }, 'The config file dwfb.config.js has an unknown key workflow');
    assertUsageError({}, 'The config file dwfb.config.js has no workflows list');
    assertUsageError({ workflows: { entry: 'a.js' } }, 'The config file dwfb.config.js has no workflows list');
  });

  it('names the workflow of a missing or wrong-typed field, an unknown key and a hole in the list', () => {
    const label = 'Workflow 2 of the config file dwfb.config.js';
    const first = { entry: 'a.js', out: 'a.out.js' };

    assertUsageError({ workflows: [first, 'b.js'] }, `${label} is not an object of the form { entry, out, banner, validate, scenarios, map, snapshot, promptBudgets }`);
    assertUsageError({ workflows: [first, , first] }, `${label} is not an object of the form { entry, out, banner, validate, scenarios, map, snapshot, promptBudgets }`);
    assertUsageError({ workflows: [first, { entry: 'b.js', output: 'b.out.js' }] }, `${label} has an unknown key output`);
    assertUsageError({ workflows: [first, { out: 'b.out.js' }] }, `${label} needs entry, the path of an entry file`);
    assertUsageError({ workflows: [first, { entry: '', out: 'b.out.js' }] }, `${label} needs entry, the path of an entry file`);
    assertUsageError({ workflows: [first, { entry: 'b.js', out: 1 }] }, `${label} needs out, the path of the built script`);
    assertUsageError({ workflows: [first, { entry: 'b.js', out: 'b.out.js', banner: 'no' }] }, `${label} takes banner as a boolean`);
    assertUsageError({ workflows: [first, { entry: 'b.js', out: 'b.out.js', validate: 'no' }] }, `${label} takes validate as a boolean`);
    assertUsageError({ workflows: [first, { entry: 'b.js', out: 'b.out.js', validate: null }] }, `${label} takes validate as a boolean`);
    for (const scenarios of ['', 5, null]) {
      assertUsageError({ workflows: [first, { entry: 'b.js', out: 'b.out.js', scenarios }] }, `${label} takes scenarios as the path of a scenarios file`);
    }
  });

  it('names an entry, out or scenarios path that ends in a path separator, . or .., which resolve() would drop or fold', () => {
    const label = 'Workflow 1 of the config file dwfb.config.js';

    assertUsageError({ workflows: [{ entry: 'a.js/', out: 'a.out.js' }] }, `${label} gives the entry a.js/, which is not a file`);
    assertUsageError({ workflows: [{ entry: 'a.js', out: 'dist/' }] }, `${label} gives the out path dist/, which names a folder`);
    assertUsageError({ workflows: [{ entry: 'a.js/.', out: 'a.out.js' }] }, `${label} gives the entry a.js/., which is not a file`);
    assertUsageError({ workflows: [{ entry: 'a.js', out: 'dist/deeper/..' }] }, `${label} gives the out path dist/deeper/.., which names a folder`);
    assertUsageError({ workflows: [{ entry: 'a.js', out: 'a.out.js', scenarios: 'scenarios.js/' }] }, `${label} gives the scenarios scenarios.js/, which is not a file`);
    assertUsageError({ workflows: [{ entry: 'a.js', out: 'a.out.js', scenarios: 'tests/..' }] }, `${label} gives the scenarios tests/.., which is not a file`);
  });

  it('names two workflows that write one out file by any spelling of its path', () => {
    assertUsageError(
      { workflows: [{ entry: 'a.js', out: 'dist/out.js' }, { entry: 'b.js', out: 'dist/b.js' }, { entry: 'c.js', out: './dist/../dist/out.js' }] },
      'Workflows 1 and 3 of the config file dwfb.config.js both write ./dist/../dist/out.js',
    );
  });

  it('names two out paths that differ only in letter case, on every platform', () => {
    assertUsageError(
      { workflows: [{ entry: 'a.js', out: 'dist/out.js' }, { entry: 'b.js', out: 'DIST/Out.js' }] },
      'Workflows 1 and 2 of the config file dwfb.config.js write dist/out.js and DIST/Out.js, which name one file where file names ignore letter case',
    );
  });

  it('names an out path that names the scenarios file of its own or another workflow, by any spelling or letter case', () => {
    assertUsageError(
      { workflows: [{ entry: 'a.js', out: 's.js', scenarios: 's.js' }] },
      'Workflow 1 of the config file dwfb.config.js writes s.js, which names the scenarios file s.js of workflow 1',
    );
    assertUsageError(
      { workflows: [{ entry: 'a.js', out: 'a.out.js', scenarios: 'tests/a.scenarios.js' }, { entry: 'b.js', out: './dist/../tests/a.scenarios.js' }] },
      'Workflow 2 of the config file dwfb.config.js writes ./dist/../tests/a.scenarios.js, which names the scenarios file tests/a.scenarios.js of workflow 1',
    );
    assertUsageError(
      { workflows: [{ entry: 'a.js', out: 'a.out.js', scenarios: 'tests/a.scenarios.js' }, { entry: 'b.js', out: './Tests/A.scenarios.js' }] },
      'Workflow 2 of the config file dwfb.config.js writes ./Tests/A.scenarios.js, which names the scenarios file tests/a.scenarios.js of workflow 1 where file names ignore letter case',
    );
  });

  it('names the scenarios file that an out path names in the same letter case before one that differs only in letter case', () => {
    assertUsageError(
      { workflows: [{ entry: 'a.js', out: 'a.out.js', scenarios: 'S.js' }, { entry: 'b.js', out: 'b.out.js', scenarios: 's.js' }, { entry: 'c.js', out: 's.js' }] },
      'Workflow 3 of the config file dwfb.config.js writes s.js, which names the scenarios file s.js of workflow 2',
    );
  });
});
