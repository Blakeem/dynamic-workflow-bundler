import { checkDocumentFiles } from './check-document-files.js';
import { findDocumentTargets } from './find-document-targets.js';
import { parseDocumentArgs } from './parse-document-args.js';
import { EXIT_FINDINGS, EXIT_SUCCESS, formatWrittenNote, printCommandFailure, printResult } from './print-result.js';
import { compareDocumentFile } from './write-document.js';

/** @typedef {import('./document-kinds.js').DocumentKind} DocumentKind */
/** @typedef {import('./find-document-targets.js').DocumentTarget} DocumentTarget */
/** @typedef {import('../src/format-document-file-line.js').DocumentCheck} DocumentCheck */

/**
 * @typedef {{ target: DocumentTarget, result: { ok: boolean }, document: string | null }} TargetDocument One
 *   script with its document, or null in `document` when the script has none.
 */

/**
 * @typedef {object} DocumentOutput
 * @property {string} text The text a person reads.
 * @property {boolean} isSuccess False when the script or its document file has a problem.
 * @property {boolean} isWritten True when the document file was written.
 */

/**
 * @template {TargetDocument} T
 * @typedef {object} DocumentCommand
 * @property {(target: DocumentTarget) => Promise<T>} readTarget
 * @property {(targetDocument: T, isCheck: boolean) => Promise<DocumentOutput>} writeTarget Writes, compares or prints one document.
 * @property {(targetDocuments: T[], checks: (DocumentCheck | null)[], isSuccess: boolean) => object} formatJson
 */

/**
 * Runs `dwfb map` or `dwfb snapshot`.
 * @template {TargetDocument} T
 * @param {DocumentKind} kind
 * @param {string[]} args
 * @param {string} usage
 * @param {DocumentCommand<T>} command
 * @returns {Promise<number>}
 */
export async function runDocumentCommand(kind, args, usage, { readTarget, writeTarget, formatJson }) {
  let targets = null;
  let isSuccess = true;
  const targetDocuments = [];
  const checks = [];
  const writtenFiles = [];

  const parsed = parseDocumentArgs(kind, args, usage);
  if (parsed.exitCode !== null) return parsed.exitCode;
  const { script, values } = parsed;

  // Every document is made before any file is written, so a usage error in a later workflow writes nothing.
  try {
    targets = await findDocumentTargets(kind, script, values);
    await checkDocumentFiles(kind, targets, values);
    for (const target of targets) targetDocuments.push(await readTarget(target));
    if (values.json) for (const targetDocument of targetDocuments) checks.push(values.check ? await checkTargetDocument(targetDocument) : null);
  } catch (error) {
    return printCommandFailure(kind.command, error);
  }

  if (values.json) {
    isSuccess = targetDocuments.every(({ result }, index) => result.ok && (checks[index] === null || checks[index] === 'fresh'));
    return printResult(`${JSON.stringify(formatJson(targetDocuments, checks, isSuccess), null, 2)}\n`, isSuccess ? EXIT_SUCCESS : EXIT_FINDINGS);
  }
  for (const targetDocument of targetDocuments) {
    let output = null;
    try {
      output = await writeTarget(targetDocument, values.check === true);
    } catch (error) {
      return printCommandFailure(kind.command, error, await formatWrittenNote(writtenFiles));
    }
    process.stdout.write(output.text);
    if (output.isWritten) writtenFiles.push(/** @type {string} */ (targetDocument.target.file));
    if (!output.isSuccess) isSuccess = false;
  }

  return isSuccess ? EXIT_SUCCESS : EXIT_FINDINGS;
}

/**
 * @param {TargetDocument} targetDocument A target of `--check`, whose document file is not null.
 * @returns {Promise<DocumentCheck | null>} Null for a script with no document, which has nothing to compare.
 */
async function checkTargetDocument({ target, document }) {
  if (document === null) return null;

  return compareDocumentFile(/** @type {string} */ (target.file), document);
}
