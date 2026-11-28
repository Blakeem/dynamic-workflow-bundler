const DIGIT_RUN = /\d+/g;

/**
 * Writes each run of ASCII digits as `N`, so that end states such as `round 3 of 5` and `round 12 of 40` compare
 * as one end state.
 * @param {string} label
 * @returns {string}
 */
export function normalizeDigits(label) {
  return label.replace(DIGIT_RUN, 'N');
}
