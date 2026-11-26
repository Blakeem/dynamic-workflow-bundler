import { isFolderPath } from './display-path.js';
import { findRealPath } from './real-path.js';

/**
 * Finds the config workflows whose entry or out names the same file as a path, such as through a link.
 * @template {{ entry: string, out: string }} Workflow
 * @param {Workflow[]} workflows
 * @param {'entry' | 'out'} field
 * @param {string} path Relative paths resolve against the working directory.
 * @returns {Promise<Workflow[]>} In the order of `workflows`. Empty for a path that names a folder, such as
 *   `a.js/`, whose real path drops the separator.
 */
export async function findConfigWorkflows(workflows, field, path) {
  const matchingWorkflows = [];
  let file = '';

  if (isFolderPath(path)) return matchingWorkflows;
  file = await findRealPath(path);
  for (const workflow of workflows) {
    if ((await findRealPath(workflow[field])) === file) matchingWorkflows.push(workflow);
  }

  return matchingWorkflows;
}
