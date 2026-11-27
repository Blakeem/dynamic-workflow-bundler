import assert from 'node:assert/strict';

const FENCE_PATTERN = /^`{3,}/;
const SECTION_HEADING_START = '## ';

/**
 * @param {string} document A Markdown document, such as README.md or a flow map.
 * @param {string} heading
 * @returns {string} The section of the document that opens with the heading, up to the next section. A `## `
 *   line inside a fenced code block, such as an example Markdown document, opens no section.
 */
export function sliceMarkdownSection(document, heading) {
  const sectionStart = document.indexOf(heading);
  let openFence = '';
  let lineStart = sectionStart + heading.length;

  assert.notEqual(sectionStart, -1, `The document has no line ${heading.trim()}`);
  for (const line of document.slice(lineStart).split('\n')) {
    const fence = FENCE_PATTERN.exec(line)?.[0] ?? '';
    if (openFence === '' && line.startsWith(SECTION_HEADING_START)) return document.slice(sectionStart, lineStart - 1);
    // A fence closes at a line of backticks alone, at least as many as the line that opened it.
    if (openFence === '') openFence = fence;
    else if (fence.length >= openFence.length && line.trimEnd() === fence) openFence = '';
    lineStart += line.length + 1;
  }

  return document.slice(sectionStart);
}
