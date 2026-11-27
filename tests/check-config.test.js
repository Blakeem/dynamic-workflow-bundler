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
  it('resolves each path against the config file folder, defaults banner and validate to true and scenarios to null', () => {
    const config = check({
      workflows: [{ entry: 'a/entry.js', out: '../dist/a.js' }, { entry: 'b.js', out: 'b.out.js', banner: false, validate: false, scenarios: '../b/scenarios.js' }],
    });

    assert.deepEqual(config, {
      workflows: [
        { entry: join(PROJECT_FOLDER, 'a', 'entry.js'), out: resolve(PROJECT_FOLDER, '..', 'dist', 'a.js'), banner: true, validate: true, scenarios: null },
        { entry: join(PROJECT_FOLDER, 'b.js'), out: join(PROJECT_FOLDER, 'b.out.js'), banner: false, validate: false, scenarios: resolve(PROJECT_FOLDER, '..', 'b', 'scenarios.js') },
      ],
    });
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

    assertUsageError({ workflows: [first, 'b.js'] }, `${label} is not an object of the form { entry, out, banner, validate, scenarios }`);
    assertUsageError({ workflows: [first, , first] }, `${label} is not an object of the form { entry, out, banner, validate, scenarios }`);
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
