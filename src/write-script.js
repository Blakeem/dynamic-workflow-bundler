import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Writes the script to a temporary file beside `outFile` and renames it over `outFile`, so a failed
 * write leaves an earlier script whole. Creates the folder of `outFile` when it is missing.
 * Rejects with a file system error whose `path` is `outFile`, since the temporary file's name is random.
 * @param {string} outFile An absolute path.
 * @param {string} script
 */
export async function writeScript(outFile, script) {
  const folder = dirname(outFile);
  // The name leaves out the out file's name, so a long out file name cannot push it past the name length limit.
  const temporaryFile = join(folder, `.dwfb-${randomBytes(6).toString('hex')}.tmp`);

  try {
    await mkdir(folder, { recursive: true });
    await writeFile(temporaryFile, script, 'utf8');
    await rename(temporaryFile, outFile);
  } catch (error) {
    // A failed cleanup leaves a stray temporary file, and its error would hide the cause and the out file.
    await rm(temporaryFile, { force: true }).catch(() => {});
    throw Object.assign(new Error(`Could not write ${outFile} (${error.syscall} ${error.code})`, { cause: error }), {
      code: error.code,
      syscall: error.syscall,
      path: outFile,
    });
  }
}
