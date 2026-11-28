import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BANNER_END, BANNER_START } from '../src/banner.js';
import { isBuiltScript } from '../src/is-built-script.js';
import { DEEP_REGEXP_LITERAL } from './support/deep-regexp-literal.js';

const META = "export const meta = { name: 'p', description: 'd' };";
const BANNER_LINE = `${BANNER_START}../entry.js${BANNER_END}`;
const BANNER_SCRIPT = `${META}\n${BANNER_LINE}\nreturn 1;\n`;
const NO_BANNER_SCRIPT = `${META}\nreturn 1;\n`;

describe('isBuiltScript', () => {
  it('gives true for a script with a banner, with and with no banner', () => {
    assert.equal(isBuiltScript(BANNER_SCRIPT, true), true);
    assert.equal(isBuiltScript(BANNER_SCRIPT, false), true);
  });

  it('gives true for a script whose first statement is the meta statement only with no banner', () => {
    assert.equal(isBuiltScript(NO_BANNER_SCRIPT, false), true);
    assert.equal(isBuiltScript(NO_BANNER_SCRIPT, true), false);
  });

  it('gives false for an empty text, Markdown, a text that does not parse with no banner line, and a script whose first statement is no meta statement', () => {
    const texts = ['', '# Notes\n\nSome `code` here.\n', 'export const meta = {;\nreturn 1;\n', `const first = 1;\n${META}\nreturn 1;\n`];

    for (const text of texts) {
      assert.equal(isBuiltScript(text, true), false, text);
      assert.equal(isBuiltScript(text, false), false, text);
    }
  });

  it('gives true for a script with a banner and a merge conflict marker, with LF and with CRLF line ends', () => {
    const conflictScript = `${META}\n${BANNER_LINE}\n<<<<<<< HEAD\nreturn 1;\n=======\nreturn 2;\n>>>>>>> other\n`;
    const crlfScript = conflictScript.split('\n').join('\r\n');

    for (const text of [conflictScript, crlfScript]) {
      assert.equal(isBuiltScript(text, true), true, JSON.stringify(text));
      assert.equal(isBuiltScript(text, false), true, JSON.stringify(text));
    }
  });

  it('gives true only with no banner for a script with no banner and a merge conflict marker, whose first side has the meta statement first', () => {
    const conflictScript = `${META}\n<<<<<<< HEAD\nreturn 1;\n=======\nreturn 2;\n>>>>>>> other\n`;
    const texts = [conflictScript, conflictScript.split('\n').join('\r\n')];
    const refusedTexts = [`<<<<<<< HEAD\nreturn 1;\n=======\n${META}\n>>>>>>> other\n`, `${META}\n<<<<<<< HEAD\nconst x = ;\n=======\nreturn 2;\n>>>>>>> other\n`];

    for (const text of texts) {
      assert.equal(isBuiltScript(text, false), true, JSON.stringify(text));
      assert.equal(isBuiltScript(text, true), false, JSON.stringify(text));
    }
    for (const text of refusedTexts) assert.equal(isBuiltScript(text, false), false, text);
  });

  it('gives true for a script whose meta statement and banner are inside a merge conflict, from the first side of the conflict', () => {
    const otherMeta = "export const meta = { name: 'p', description: 'other' };";
    const texts = [
      `<<<<<<< HEAD\n${META}\n${BANNER_LINE}\n=======\n${otherMeta}\n${BANNER_LINE}\n>>>>>>> other\nreturn 1;\n`,
      `<<<<<<< HEAD\n${META}\n||||||| base\n${otherMeta}\n=======\n${otherMeta}\n>>>>>>> other\n${BANNER_LINE}\nreturn 1;\n`,
    ];

    for (const text of texts) assert.equal(isBuiltScript(text, true), true, text);
  });

  it('gives true for a script with a merge conflict marker and a line of a marker form outside the conflict, such as a setext heading in a template literal', () => {
    const conflict = '<<<<<<< HEAD\nreturn 1;\n=======\nreturn 2;\n>>>>>>> other\n';
    const prompt = 'const prompt = `Summary\n=======\nReview it.\n>>>>>>> quoted\n`;\n';

    assert.equal(isBuiltScript(`${META}\n${BANNER_LINE}\n${prompt}${conflict}`, true), true);
    assert.equal(isBuiltScript(`${META}\n${prompt}${conflict}`, false), true);
  });

  it('gives true for a text that does not parse with comments before the meta statement or a meta statement that does not parse', () => {
    const texts = [`// lead\n/* block */\n${META}\n${BANNER_LINE}\n<<<<<<< HEAD\n`, `export const meta = {;\n${BANNER_LINE}\nreturn 1;\n`];

    for (const text of texts) assert.equal(isBuiltScript(text, true), true, text);
  });

  it('gives false for a text that does not parse and quotes the banner line inside a template literal or a block comment, or that the tokenizer refuses', () => {
    const texts = [
      `${META}\nconst prompt = \`A built script holds this line:\n${BANNER_LINE}\nCheck it.\`;\nconst x = ;\nreturn agent(prompt);\n`,
      `${META}\n/*\n${BANNER_LINE}\n*/\nconst x = ;\n`,
      `${META}\nconst prompt = \`\n${BANNER_LINE}\n`,
      `${META}\n${DEEP_REGEXP_LITERAL};\n${BANNER_LINE}\nconst x = ;\n`,
      `'export' 'const' 'meta'\n${BANNER_LINE}\n`,
    ];

    for (const text of texts) {
      assert.equal(isBuiltScript(text, true), false, text.slice(0, 200));
      assert.equal(isBuiltScript(text, false), false, text.slice(0, 200));
    }
  });

  it('gives false for a text that does not parse and quotes a banner line with no meta statement before it that opens the text', () => {
    const texts = [
      `# Notes\n\nA built script starts like this:\n\n    ${META}\n    ${BANNER_LINE}\n\n${BANNER_LINE}\n\nWritten by hand.\n`,
      `# Notes\n\n\`\`\`js\n${META}\n${BANNER_LINE}\n\`\`\`\n`,
      `const first = 1;\n${META}\n${BANNER_LINE}\n<<<<<<< HEAD\n`,
      `<<<<<<< HEAD\nreturn 1;\n=======\n${META}\n${BANNER_LINE}\n>>>>>>> other\n`,
    ];

    for (const text of texts) {
      assert.equal(isBuiltScript(text, true), false, text);
      assert.equal(isBuiltScript(text, false), false, text);
    }
  });

  it('gives true only with no banner for a text that does not parse and has a banner line before the meta statement', () => {
    const text = `${BANNER_LINE}\n${META}\n<<<<<<< HEAD\n`;

    assert.equal(isBuiltScript(text, true), false);
    assert.equal(isBuiltScript(text, false), true);
  });

  it('gives false for a text that does not parse and holds a banner line with no path or with text around it', () => {
    const texts = [`${META}\n${BANNER_START}${BANNER_END}\n<<<<<<< HEAD\n`, `${META}\n ${BANNER_LINE}\n<<<<<<< HEAD\n`, `${META}\n${BANNER_LINE} x\n<<<<<<< HEAD\n`];

    for (const text of texts) assert.equal(isBuiltScript(text, true), false, text);
  });

  it('gives false with a banner for a text that quotes the banner line inside a string or a block comment', () => {
    const texts = [
      `${META}\nconst quoted = \`\n${BANNER_LINE}\n\`;\n`,
      `${META}\n/*\n${BANNER_LINE}\n*/\n`,
      `${META}\nconst quoted = ${JSON.stringify(BANNER_LINE)};\n`,
    ];

    for (const text of texts) assert.equal(isBuiltScript(text, true), false, text);
  });
});
