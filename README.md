# dynamic-workflow-bundler

Build, validate and simulate dynamic workflow scripts for Claude Code.

A dynamic workflow is one JavaScript file. The Workflow runtime loads no second file, so a large workflow
is one long script, and two workflows cannot share code. This tool removes that limit at build time.

**Status:** in development and not yet on npm. The [roadmap](docs/roadmap.md) lists what is built.

## Commands

| Command | Purpose | Status |
|---|---|---|
| `dwfb build` | Build a workflow script from an entry, its parts, and the modules, text files and JSON files it imports, or every workflow of a config file. | available |
| `dwfb locate` | Find the source file and line that a line of a built script comes from. | available |
| `dwfb validate` | Report each rule of the Workflow runtime that a script breaks, before launch. | available |
| `dwfb simulate` | Run a script against scripted agent returns, with no model call. | planned |
| `dwfb inspect` | Show what each agent of a simulation received and returned. | planned |

## dwfb build

The entry is the file that holds `meta` and the top-level body of the workflow. It imports source files by relative paths.

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

The built script holds the `meta` statement, a banner line, the text files and JSON files, one scope per module and the rest of the entry. Each source line keeps its order, and a JavaScript line outside an import or export statement keeps its text. `--no-banner` leaves out the banner line. `--json` prints the result as one JSON object.

A specifier starts with `./` or `../`. A specifier that ends in `.js` or `.mjs` names a module. Each module is evaluated once, before the files that import it, as in an ES module.

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

A source that uses another form, such as `export let`, `export * from` or `import()`, stops the build with a finding. An import cycle also stops the build. So does a specifier that names a folder, such as `./` or `./lib/`. So does a direct `eval` call in a module, since in the built script the call can read the entry's names. So does a source that is not valid UTF-8. A finding prints as `<file>:<line>:<column> <rule id> <what is wrong>. <how to fix it>.`, and the build writes nothing.

A namespace import, such as `import * as a from './a.js'`, gives a frozen object, so the descriptor of each of its members reports `writable: false`. An ES module namespace reports `writable: true`. A write to a member throws in both.

### Text files and JSON files

A specifier that ends in `.json` names a JSON file, and any other ending names a text file. An ending that an ES runtime reads as code or JSON, such as `.cjs`, `.ts` or `.JSON`, stops the build with a finding. So does a specifier with no ending, such as `./prompt`, since an ES runtime reads that file as code. A `type` attribute of `text` or `json` decides in place of the ending. A text file and a JSON file take a default import only.

```js
import reviewPrompt from './review-prompt.md';
import limits from './limits.json';
import example from './example.js' with { type: 'text' };
```

A text file is imported as a string of its content, with a byte order mark dropped and CRLF read as LF. Each of its lines is a line of the built script, with a backtick, `${` and a backslash escaped, so a diff of the built script shows a prompt edit line by line. A JSON file is imported as the value `JSON.parse` gives for its content, and every importer gets the same object. The built script holds each file once.

### Parts

A long entry can be cut into parts. A `// @include <path>` line in the entry names a part by its path relative to the entry's folder, and the build puts the part's text in place of that line. The path uses forward slashes and the letter case of the names on disk.

`workflows/review/entry.js`:

```js
export const meta = { name: 'review', description: 'Review a change' };

// @include ./steps/collect.js
// @include ./steps/review.js
```

A part is a list of complete statements with no `import` or `export`. One `// @include` line names it, and no import reads it as a module. A `// @include` line sits alone on its line at the top level of the entry, below `meta`. A part or a `// @include` line that breaks these rules stops the build with a finding. A `// @include` line inside a template literal is text.

### Config file

A project with several workflows lists them in `dwfb.config.js` or `dwfb.config.mjs` in the folder the command runs in. The file is an ES module whose default export names the entry and the built script of each workflow. Node loads a `.js` file as CommonJS when the nearest `package.json` sets `"type": "commonjs"`, and before Node 22.7 when it sets no type. So a project whose package is not an ES module package names its config file `dwfb.config.mjs`. When both files exist, a command that needs the config file stops until one is removed or `--config <path>` names one. Each path is relative to the config file's folder.

```js
export default {
  workflows: [
    { entry: 'workflows/review/entry.js', out: '.claude/workflows/review.js' },
    { entry: 'workflows/summary/entry.js', out: '.claude/workflows/summary.js', banner: false },
  ],
};
```

`dwfb build` with no entry builds every workflow in order, and `dwfb build <entry>` builds each workflow whose entry is that file. A workflow with a finding does not stop the workflows after it. `banner: false` leaves out the banner line of one workflow, and `--no-banner` leaves it out of every workflow. `--config <path>` names another config file. `dwfb build <entry> --out <file>` reads no config file. A config file that does not load, has an unknown key, lists no workflow, gives a field of the wrong type or gives two workflows one `out` stops the command before it writes anything. Two `out` paths that differ only in letter case count as one `out`. Two `out` paths that name one file through a link count as one `out` among the workflows the command builds. A missing entry, or an `out` that the build refuses, such as a folder or a source file of a workflow the command builds, stops the command before it writes anything too.

### Check

`dwfb build --check` builds each workflow in memory and compares the result with the file at `out`, and it writes nothing. The command exits 0 when every file matches. It exits 1 when a file differs or is missing, or a workflow has a finding. For a file that differs, it prints the file's first differing line and the source file and line that this line comes from. This way a commit hook or a CI job can stop a built script that no longer matches its source.

The build reads each source through its real path, as Node does. So a path in the built script, such as the banner path or a module's path comment, follows a symbolic link or a junction to where its target sits. Two machines build the same bytes when each link's target sits at the same place relative to the entry. A link that git stores with a relative target gives that.

## dwfb locate

An error message, a review finding or a diff names a line of the built script. `dwfb locate` prints the source file, line and column of that line, then the source line.

```
$ dwfb locate .claude/workflows/review.js 14
workflows/review/entry.js:5:1
return await agent(reviewPrompt(args.change));
```

A line can carry a column, as in `14:5`. The Workflow runtime numbers lines from the code after the `meta` statement, so the line in a stack trace can differ from the built script's line. `--runtime` reads the line and column as the runtime reports them. For a stack trace line `workflow.js:6:10`, run this command:

```
$ dwfb locate .claude/workflows/review.js 6:10 --runtime
workflows/review/prompts.js:2:10
  return `Review this change.
```

The command finds the entry from the banner line. A banner that names no relative path stops the command. A script with no banner takes the entry of the config file's workflow whose `out` is the script, and `--config <path>` names another config file. `--entry <file>` names the entry in place of both. Then the command builds the script in memory. For a line that the build adds, such as the banner or the first line of a module's scope, it says so, and names the source file whose constant, scope or imported names the line holds when there is one. A built script that differs from the script the build gives stops the command with the finding `script-stale`, since its line numbers may not match the source. The finding names the `dwfb build` command that rewrites it. `--json` prints the result as one JSON object.

## dwfb validate

`dwfb validate` checks a workflow script against the rules that the Workflow runtime enforces. This way a script that the runtime refuses or that throws is found before launch.

```
$ dwfb validate .claude/workflows/review.js
.claude/workflows/review.js:4:17 clock-unavailable The script uses Date.now, which throws in the runtime when called. Pass the time through args, or stamp the result after the workflow returns.
```

The command takes several scripts. With no script, it checks the `out` of each workflow of the config file, and `--config <path>` names another config file. A script that breaks no rule gets one line that says so. The command exits 0 when no script breaks a rule and 1 when one does. `--json` prints the result as one JSON object.

The command reads a script as the runtime does. A byte sequence that is not valid UTF-8 is read as U+FFFD, and the size limit counts the bytes of the file. A script larger than 2,097,152 bytes gets the `script-too-large` finding alone, since a check of its other rules may run out of memory.

| Rule | What the runtime does |
|---|---|
| `script-too-large` | Refuses a script file larger than 524,288 bytes. |
| `syntax-error` | Refuses a script that does not parse. |
| `source-too-deep` | No runtime rule. The code is nested deeper than dwfb can read, so dwfb cannot check it. |
| `meta-not-first` | Refuses a script whose first statement is not `export const meta = { ... }`. |
| `meta-not-literal` | Refuses a meta object that holds a value other than a literal, or a key named `__proto__`, `constructor` or `prototype`. |
| `meta-name-invalid` | Refuses a meta object whose `name` is not a string of 1 or more characters. |
| `meta-description-invalid` | Refuses a meta object whose `description` is not a string of 1 or more characters. |
| `script-export` | Refuses a script with an export other than `meta`. |
| `script-import` | Refuses a script with a static `import`. |
| `import-dynamic` | Refuses a script that holds `import()`. |
| `import-meta` | Refuses a script that holds `import.meta`. |
| `await-using` | Refuses a script with an `await using` declaration. |
| `runtime-reserved-name` | Refuses a script with a variable whose name starts with `__wRg$`. |
| `clock-unavailable` | Throws when the script calls `Date.now()`, `new Date()` with no argument or `Date()`. |
| `random-unavailable` | Throws when the script calls `Math.random()`. |
| `eval-unavailable` | Throws when the script calls `eval` or `Function`. |
| `global-undefined` | Throws a `ReferenceError` when the script reads or assigns a name that it does not declare and the runtime does not define, such as `require` or `process`. |

The rules were measured on Claude Code 2.1.332, and a rule may differ on another version.

The command does not check the arguments of `agent`, `parallel`, `pipeline`, `phase`, `log` and `workflow`, the script's return value, or the 30 second limit on code that does not yield. Each depends on values that exist only when the script runs. A rule reads the direct form of the code only. So `Date.now()` gets a finding, and `const { now } = Date; now()` or `(0, eval)('1')` gets none, although each throws.

## License

MIT. See [LICENSE](LICENSE).

This project is independent. It is not affiliated with, sponsored by or endorsed by Anthropic.
