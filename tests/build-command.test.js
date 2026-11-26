import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { formatBuildCommand, formatCommandPath } from '../src/build-command.js';

describe('build-command', () => {
  it('names each option it is given, in the order entry, --out, --config, --no-banner', () => {
    assert.equal(formatBuildCommand(undefined, {}), 'dwfb build');
    assert.equal(formatBuildCommand(undefined, { config: 'other.config.js' }), 'dwfb build --config other.config.js');
    assert.equal(formatBuildCommand(join(process.cwd(), 'src', 'entry.js'), { out: 'dist/w.js', 'no-banner': true }), 'dwfb build src/entry.js --out dist/w.js --no-banner');
  });

  it('quotes a path that holds a character a shell reads', () => {
    assert.equal(formatCommandPath(join('my folder', 'w.js')), '"my folder/w.js"');
    assert.equal(formatCommandPath('out(1).js'), '"out(1).js"');
    assert.equal(formatCommandPath('dist/w-1.js'), 'dist/w-1.js');
  });

  it('puts ./ before a path that starts with -, which the command would read as an option', () => {
    assert.equal(formatCommandPath('-e.js'), './-e.js');
    assert.equal(formatCommandPath('./-e.js'), './-e.js');
    assert.equal(formatCommandPath('-my file.js'), '"./-my file.js"');
    assert.equal(formatBuildCommand('-e.js', { out: '-o.js' }), 'dwfb build ./-e.js --out ./-o.js');
  });
});
