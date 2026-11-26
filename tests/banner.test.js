import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BANNER_END, BANNER_START, findBanner } from '../src/banner.js';

describe('findBanner', () => {
  it('reads the entry path of a banner on the line after the meta statement', () => {
    const script = `export const meta = {\n};\n${BANNER_START}../workflows/review/entry.js${BANNER_END}\nreturn 1;\n`;

    assert.deepEqual(findBanner(script), { path: '../workflows/review/entry.js', hasSyntaxError: false });
  });

  it('gives no path for a script with no banner, a banner on another line, a banner with no path and a block comment', () => {
    const scripts = [
      'export const meta = {};\nreturn 1;\n',
      `export const meta = {};\n\n${BANNER_START}entry.js${BANNER_END}\n`,
      `export const meta = {};\n${BANNER_START}${BANNER_END}\n`,
      `export const meta = {};\n/*${BANNER_START.slice(2)}entry.js${BANNER_END}*/\n`,
      `export const meta = {};${BANNER_START}entry.js${BANNER_END}`,
      '',
    ];

    for (const script of scripts) assert.deepEqual(findBanner(script), { path: null, hasSyntaxError: false }, script);
  });

  it('gives no path and a syntax error for a script that does not parse', () => {
    assert.deepEqual(findBanner(`export const meta = {;\n${BANNER_START}entry.js${BANNER_END}\n`), { path: null, hasSyntaxError: true });
  });
});
