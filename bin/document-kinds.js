/**
 * @typedef {object} DocumentKind A document that a command writes for a script from its scenarios.
 * @property {string} command Such as `dwfb map`, which each message of the command starts with.
 * @property {'map' | 'snapshot'} key The workflow key of the config file that names the document file.
 * @property {string} name Such as `flow map`.
 * @property {string} verb What the command does to a script, such as `maps`.
 */

/** @type {Readonly<DocumentKind>} */
export const FLOW_MAP_KIND = Object.freeze({ command: 'dwfb map', key: 'map', name: 'flow map', verb: 'maps' });
/** @type {Readonly<DocumentKind>} */
export const PROMPT_SNAPSHOT_KIND = Object.freeze({ command: 'dwfb snapshot', key: 'snapshot', name: 'prompt snapshot', verb: 'snapshots' });
// The order in which a document path is compared with the document files of a workflow.
export const DOCUMENT_KINDS = Object.freeze([FLOW_MAP_KIND, PROMPT_SNAPSHOT_KIND]);
