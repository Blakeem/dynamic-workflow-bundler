import { LABEL_SEPARATOR } from './read-roles.js';

const ROUND_MARKER_END = new RegExp(`${LABEL_SEPARATOR}+r\\d+$`);
const LEADING_SEPARATORS = new RegExp(`^${LABEL_SEPARATOR}+`);

/**
 * @param {string} label A call's label.
 * @param {string} role A role the label starts with.
 * @returns {string} The label after the role, with no round marker at its end and no separator at its start.
 */
export function readItem(label, role) {
  return label.slice(role.length).replace(ROUND_MARKER_END, '').replace(LEADING_SEPARATORS, '').trim();
}
