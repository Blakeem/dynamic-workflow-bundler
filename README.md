# dynamic-workflow-bundler

Build, validate and simulate dynamic workflow scripts for Claude Code.

A dynamic workflow is one JavaScript file. The Workflow runtime loads no second file, so a large workflow
is one long script, and two workflows cannot share code. This tool removes that limit at build time.

**Status:** in development and not yet on npm. The [roadmap](docs/roadmap.md) lists what is built.

## Commands

| Command | Purpose | Status |
|---|---|---|
| `dwfb build` | Build one workflow script from an entry and its modules. | available |
| `dwfb validate` | Report each rule of the Workflow runtime that a script breaks, before launch. | planned |
| `dwfb simulate` | Run a script against scripted agent returns, with no model call. | planned |
| `dwfb inspect` | Show what each agent of a simulation received and returned. | planned |

## dwfb build

The entry is the file that holds `meta` and the top-level body of the workflow. It imports modules by relative paths.

`workflows/review/entry.js`:

```js
export const meta = { name: 'review', description: 'Review a change' };

import { reviewPrompt } from './prompts.js';

return await agent(reviewPrompt(args.change));
```

`workflows/review/prompts.js`:

```js
export function reviewPrompt(change) {
  return `Review this change.
${change}`;
}
```

This command writes the workflow script:

```
dwfb build workflows/review/entry.js --out .claude/workflows/review.js
```

The built script holds the `meta` statement, a banner line, one scope per module and the rest of the entry. Each source line keeps its order, and a line outside an import or export statement keeps its text. `--no-banner` leaves out the banner line. `--json` prints the result as one JSON object.

A module specifier starts with `./` or `../` and ends in `.js` or `.mjs`. Each module is evaluated once, before the files that import it, as in an ES module.

These import forms work:

- `import { a, b as c } from './a.js'`
- `import a from './a.js'`
- `import * as a from './a.js'`
- `import './a.js'`

These export forms work in a module:

- `export const`
- `export function`, `export async function` and `export function*`
- `export class`
- `export { a, b as c }`
- `export default`

A source that uses another form, such as `export let`, `export * from` or `import()`, stops the build with a finding. An import cycle also stops the build. So does a direct `eval` call in a module, since in the built script the call can read the entry's names. A finding prints as `<file>:<line>:<column> <rule id> <what is wrong>. <how to fix it>.`, and the build writes nothing.

## License

MIT. See [LICENSE](LICENSE).

This project is independent. It is not affiliated with, sponsored by or endorsed by Anthropic.
