/**
 * @param {string | null} label A call's label.
 * @param {string[]} roles As readRoles gives them.
 * @returns {string | null} The longest role the label starts with, or null.
 */
export function findRole(label, roles) {
  if (label === null) return null;
  const matches = roles.filter((role) => label.startsWith(role));

  return matches.length === 0 ? null : matches.reduce((longest, role) => (role.length > longest.length ? role : longest));
}
