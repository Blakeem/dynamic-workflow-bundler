import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MISSING_FILE_CODES } from '../src/load-sources.js';
import { writeScript } from '../src/write-script.js';

/** @typedef {import('../src/format-document-file-line.js').DocumentFileOutcome} DocumentFileOutcome */
/** @typedef {import('../src/format-document-file-line.js').DocumentCheck} DocumentCheck */

/**
 * Writes or compares the file of one document. A write leaves a file whose bytes would not change in place.
 * @param {string} file
 * @param {string} document
 * @param {boolean} isCheck True to compare the file and write nothing.
 * @returns {Promise<DocumentFileOutcome>}
 */
export async function writeDocument(file, document, isCheck) {
  const fileCheck = await compareDocumentFile(file, document);

  if (isCheck) return fileCheck;
  if (fileCheck === 'fresh') return 'unchanged';
  await writeScript(resolve(file), document);
  return 'wrote';
}

/**
 * @param {DocumentFileOutcome} outcome
 * @returns {boolean} False for a file that `--check` found stale or missing.
 */
export function isFreshOutcome(outcome) {
  return outcome !== 'stale' && outcome !== 'missing';
}

/**
 * @param {string} file
 * @param {string} document
 * @returns {Promise<DocumentCheck>}
 */
export async function compareDocumentFile(file, document) {
  const fileBytes = await readExistingFile(file);

  if (fileBytes === null) return 'missing';
  return fileBytes.equals(Buffer.from(document, 'utf8')) ? 'fresh' : 'stale';
}

/**
 * @param {string} file
 * @returns {Promise<Buffer | null>} The bytes of the file, or null when no file exists at the path.
 */
async function readExistingFile(file) {
  try {
    return await readFile(resolve(file));
  } catch (error) {
    if (MISSING_FILE_CODES.has(error.code)) return null;
    throw error;
  }
}
