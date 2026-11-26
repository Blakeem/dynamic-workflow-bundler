/** @typedef {import('./cases.js').ParityCase} ParityCase */

/**
 * @typedef {object} ExportForm An export form that README.md lists as working.
 * @property {string} name
 * @property {string} declarations Lines above the export statement, which it may need.
 * @property {string} statement The export statement of the name `value`, or of the default, with no closing `;`.
 * @property {(binding: string) => string} read The expression that reads the export through a binding of it.
 * @property {boolean} isDefault
 */

/** @type {ExportForm[]} */
const EXPORT_FORMS = [
  { name: 'export const', declarations: '', statement: 'export const value = 1', read: (binding) => binding, isDefault: false },
  { name: 'export function', declarations: '', statement: 'export function value() { return 2 }', read: (binding) => `${binding}()`, isDefault: false },
  { name: 'export async function', declarations: '', statement: 'export async function value() { return 3 }', read: (binding) => `${binding}()`, isDefault: false },
  { name: 'export function*', declarations: '', statement: 'export function* value() { yield 4 }', read: (binding) => `[...${binding}()]`, isDefault: false },
  { name: 'export class', declarations: '', statement: 'export class value { static n = 5 }', read: (binding) => `${binding}.n`, isDefault: false },
  { name: 'export list', declarations: 'const inner = 6;\n', statement: 'export { inner, inner as value }', read: (binding) => binding, isDefault: false },
  { name: 'export default', declarations: '', statement: 'export default 7', read: (binding) => binding, isDefault: true },
  // `export default 7` with no `;` throws in a.js before the `(` and template literal lines, and a declaration ends at its `}`,
  // so this form runs main.js's default import against every next line.
  { name: 'export default function', declarations: '', statement: 'export default function () { return 8 }', read: (binding) => `${binding}()`, isDefault: true },
];

/**
 * @typedef {object} ImportForm
 * @property {string} name
 * @property {(isDefault: boolean) => { clause: string, binding: string }} format The import clause and the
 *   binding that reads the export.
 */

/** @type {ImportForm[]} */
const IMPORT_FORMS = [
  { name: 'binding', format: (isDefault) => (isDefault ? { clause: 'value', binding: 'value' } : { clause: '{ value }', binding: 'value' }) },
  { name: 'renamed binding', format: (isDefault) => ({ clause: `{ ${isDefault ? 'default' : 'value'} as renamed }`, binding: 'renamed' }) },
  { name: 'namespace', format: (isDefault) => ({ clause: '* as space', binding: isDefault ? 'space.default' : 'space.value' }) },
];

// Each line starts with a token that can continue the statement above when that statement has no closing `;`.
// The `/` line reads as a regular expression on its own and as two divisions after an expression.
const NEXT_LINES = [
  { name: '(', text: "(() => trail.push('paren'))()" },
  { name: '[', text: "[trail.push('bracket')]" },
  { name: 'template literal', text: "`${trail.push('template')}`" },
  { name: '+', text: "+trail.push('plus')" },
  { name: '-', text: "-trail.push('minus')" },
  { name: '/', text: "/1/g.exec(trail.push('slash'))" },
];

// The line above each statement ends in a string with no `;`, so each next line that a removed statement joins
// to it changes `lead` or throws.
const LEAD = "const trail = []\nconst g = { exec: (count) => count }\nconst lead = 'lead'\n";

/**
 * @param {ExportForm} exportForm
 * @param {ImportForm} importForm
 * @param {boolean} hasSemicolon
 * @param {{ name: string, text: string }} nextLine
 * @returns {ParityCase}
 */
function createGridCase(exportForm, importForm, hasSemicolon, nextLine) {
  const closer = hasSemicolon ? ';' : '';
  const { clause, binding } = importForm.format(exportForm.isDefault);
  const moduleText = `${exportForm.declarations}${LEAD}${exportForm.statement}${closer}\n${nextLine.text}\nexport { trail, lead };\n`;
  const mainText = `${LEAD}import ${clause} from './a.js'${closer}\n${nextLine.text}\nimport { trail as moduleTrail, lead as moduleLead } from './a.js';\nexport default Promise.all([${exportForm.read(binding)}, moduleTrail, moduleLead, trail, lead]);\n`;
  const semicolonLabel = hasSemicolon ? 'with ;' : 'without ;';

  return {
    name: `grid: ${exportForm.name}, ${importForm.name} import, ${semicolonLabel}, next line ${nextLine.name}`,
    expected: 'equal',
    files: { 'a.js': moduleText, 'main.js': mainText },
  };
}

/** @type {ParityCase[]} */
export const GRID_CASES = EXPORT_FORMS.flatMap((exportForm) =>
  IMPORT_FORMS.flatMap((importForm) =>
    [true, false].flatMap((hasSemicolon) => NEXT_LINES.map((nextLine) => createGridCase(exportForm, importForm, hasSemicolon, nextLine))),
  ),
);
