import assert from 'node:assert/strict';

/**
 * @param {string} readme
 * @param {string} heading
 * @returns {string} The README section that opens with the heading, up to the next section.
 */
export function sliceReadmeSection(readme, heading) {
  const sectionStart = readme.indexOf(heading);
  const sectionEnd = readme.indexOf('\n## ', sectionStart + heading.length);
  assert.notEqual(sectionStart, -1, `README.md has no line ${heading.trim()}`);
  return readme.slice(sectionStart, sectionEnd === -1 ? readme.length : sectionEnd);
}
