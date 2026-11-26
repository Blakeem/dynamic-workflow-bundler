import { findRealPath } from './real-path.js';

/**
 * Finds the config workflows whose entry or out names the same file as a path, such as through a link.
 * @template {{ entry: string, out: string }} Workflow
 * @param {Workflow[]} workflows
 * @param {'entry' | 'out'} field
 * @param {string} path Relative paths resolve against the working directory.
 * @returns {Promise<Workflow[]>} In the order of `workflows`.
 */
export async function findConfigWorkflows(workflows, field, path) {
  const file = await findRealPath(path);
  const matchingWorkflows = [];

  for (const workflow of workflows) {
    if ((await findRealPath(workflow[field])) === file) matchingWorkflows.push(workflow);
  }

  return matchingWorkflows;
}
