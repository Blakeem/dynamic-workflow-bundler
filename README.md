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
| `dwfb simulate` | Run a script against scripted agent returns, with no model call. | available |
| `dwfb inspect` | Show what each agent of a simulation received and returned. | available |
| `dwfb map` | Draw a Mermaid graph of every path that the scenarios of a script reach, with its loops and end states. | available |

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

The built script holds the `meta` statement, a banner line, the text files and JSON files, one scope per module and the rest of the entry. Each source line keeps its order, and a JavaScript line outside an import or export statement keeps its text. `--no-banner` leaves out the banner line. `--json` prints the result as one JSON object. When a write fails, the command prints no JSON object, and its message names each script that it wrote before the failure.

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

A source that uses another form, such as `export let`, `export * from` or `import()`, stops the build with a finding. An import cycle also stops the build. So does a specifier that names a folder, such as `./` or `./lib/`. So does a direct `eval` call in a module, since in the built script the call can read the entry's names. So does a source that is not valid UTF-8. So does a source larger than 2,097,152 bytes, with the finding `source-too-large`. So does an entry larger than 2,097,152 bytes with its parts, and so do sources whose built script is larger than 2,097,152 bytes, each with the finding `script-too-large` on the entry. A variable name that starts with `__wRg$` stops the build with the finding `runtime-reserved-name`, since the runtime refuses it.

The build then runs the contract check, which checks the built script against the rules that [`dwfb validate`](#dwfb-validate) lists. Each finding of the contract check names the source file, line and column that the code comes from. A built script larger than 524,288 bytes gets the finding `script-too-large` on the entry. `--no-validate` skips the contract check, and the build still stops a source with the finding `runtime-reserved-name`. Use `--no-validate` when a runtime newer than Claude Code 2.1.332 allows what a rule reports.

A finding prints as `<file>:<line>:<column> <rule id> <what is wrong>. <how to fix it>.`, and the build writes nothing.

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

`dwfb build` with no entry builds every workflow in order, and `dwfb build <entry>` builds each workflow whose entry is that file. A workflow with a finding does not stop the workflows after it. `banner: false` leaves out the banner line of one workflow, and `--no-banner` leaves it out of every workflow. `validate: false` skips the contract check in the build of one workflow, and `--no-validate` skips it for every workflow. `--config <path>` names another config file. `dwfb build <entry> --out <file>` reads no config file. A config file that does not load, has an unknown key, lists no workflow, gives a field of the wrong type or gives two workflows one `out` stops the command before it writes anything. Two `out` paths that differ only in letter case count as one `out`. Two `out` paths that name one file through a link count as one `out` among the workflows the command builds. A missing entry, or an `out` that the build refuses, such as a folder or a source file of a workflow the command builds, stops the command before it writes anything too.

`scenarios` names the scenarios file that [`dwfb simulate`](#dwfb-simulate), [`dwfb inspect`](#dwfb-inspect) and [`dwfb map`](#dwfb-map) run the workflow's `out` against, as in `{ entry: 'workflows/review/entry.js', out: '.claude/workflows/review.js', scenarios: 'workflows/review/scenarios.js' }`. An `out` that names the scenarios file of any workflow, in any letter case, or the scenarios file of a workflow the command builds through a link, stops the command before it writes anything.

`map` names the flow map file that [`dwfb map`](#dwfb-map) writes for the workflow's `out`, as in `map: 'docs/review.flow-map.md'`. A workflow with `map` needs `scenarios`. A `map` that names an entry, an `out`, a scenarios file or another `map` of any workflow, in any letter case, stops every command that reads the config file.

### Check

`dwfb build --check` builds each workflow in memory and compares the result with the file at `out`, and it writes nothing. The command exits 0 when every file matches. It exits 1 when a file differs or is missing, or a workflow has a finding. A finding of the contract check counts too, and the command compares no file for that workflow. With `--no-validate`, the command compares the file. For a file that differs, it prints the file's first differing line and the source file and line that this line comes from. This way a commit hook or a CI job can stop a built script that no longer matches its source.

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

The command finds the entry from the banner line. A banner that names no relative path stops the command. A script with no banner takes the entry of the config file's workflow whose `out` is the script, and `--config <path>` names another config file. `--entry <file>` names the entry in place of both. Then the command builds the script in memory with no contract check, so a script that breaks a rule still maps to its source. For a line that the build adds, such as the banner or the first line of a module's scope, it says so, and names the source file whose constant, scope or imported names the line holds when there is one. A built script that differs from the script the build gives stops the command with the finding `script-stale`, since its line numbers may not match the source. The finding names the `dwfb build` command that rewrites it. That command holds `--no-validate` when the script it builds breaks a rule of the contract check, since the build would refuse it. A script larger than 2,097,152 bytes stops the command, since the runtime refuses a script larger than 524,288 bytes. `--json` prints the result as one JSON object.

## dwfb validate

`dwfb validate` checks a workflow script against the rules that the Workflow runtime enforces. This way a script that the runtime refuses or that throws is found before launch.

```
$ dwfb validate .claude/workflows/review.js
.claude/workflows/review.js:4:17 clock-unavailable The script uses Date.now, which throws in the runtime when called. Pass the time through args, or stamp the result after the workflow returns.
```

The command takes several scripts. With no script, it checks the `out` of each workflow of the config file, and `--config <path>` names another config file. It skips each workflow with `validate: false` and prints one line for each skipped workflow after the results. A script that the command names gets checked whatever the config file says. A script that breaks no rule gets one line that says so. The command exits 0 when no script breaks a rule and 1 when one does. `--json` prints the result as one JSON object, whose `skipped` lists the `out` of each skipped workflow.

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

The command does not check the arguments of `agent`, `parallel`, `pipeline`, `phase`, `log` and `workflow`, the script's return value, or the 30 second limit on code that does not yield. Each depends on values that exist only when the script runs. A rule reads the direct form of the code only. So `Date.now()` gets a finding, and `const { now } = Date; now()` or `(0, eval)('1')` gets none, although each throws. The clock and random rules report each place that names `Date.now` or `Math.random`, called there or not, since the function throws wherever it is called.

## dwfb simulate

`dwfb simulate` runs a workflow script against scripted agent returns, with no model call, and prints how each simulation ended. This way a change to a script's control flow is tested before launch.

`.claude/workflows/review.js`:

```js
export const meta = { name: 'review', description: 'Review a change until a review passes' };

const VERDICT_SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };

for (let round = 1; round <= 3; round += 1) {
  const review = await agent(`Review this change.\n${args.change}`, { label: 'review', schema: VERDICT_SCHEMA });
  if (review === null) throw new Error('The reviewer died');
  if (review.verdict === 'pass') return { round };
}
return { round: null };
```

`workflows/review/scenarios.js`:

```js
export default [
  { name: 'passes', args: { change: 'Fix the typo' }, respond: { review: { verdict: 'pass' } } },
  { name: 'passes on round 2', args: { change: 'Fix the typo' }, respond: { review: [{ verdict: 'fail' }, { verdict: 'pass' }] } },
  { name: 'reviewer dies', expect: 'threw', args: { change: 'Fix the typo' }, respond: { review: null } },
];
```

```
$ dwfb simulate .claude/workflows/review.js --scenarios workflows/review/scenarios.js
.claude/workflows/review.js passes: returned, 1 call.
.claude/workflows/review.js passes on round 2: returned, 2 calls.
.claude/workflows/review.js reviewer dies: threw Error: The reviewer died, 1 call.
3 passed, 0 failed.
```

A scenarios file is an ES module whose default export is a list of scenarios, and Node loads it as it loads a [config file](#config-file). Each scenario holds these keys:

| Key | Meaning |
|---|---|
| `name` | A name that no other scenario of the file has. Required. |
| `args` | The JSON value the script reads as `args`. |
| `respond` | The scripted returns of the `agent()` calls. |
| `budget` | `{ total, spent, spentPerCall }`, the numbers the script reads as its budget, each 0 or more. `total` can be `null`, and `spent` and `spentPerCall` must be finite. `spentPerCall` is added to `spent` for each `agent()` call that gets a scripted return, and defaults to 0. |
| `expect` | `'returned'` or `'threw'`, the end that passes the scenario. Defaults to `'returned'`. |

A scripted return is a string for a call with no schema, a plain JSON object for a call with a schema, or `null` for an agent that died. The script gets a copy of it, so a change the script makes to one return reaches no other call.

`respond` is an object keyed by label prefix, or a function. For an object, the longest key that the call's label starts with decides. The key `''` matches every call, a call with no label included. A key's value is a scripted return, a list of scripted returns or a function. A list gives its first element to the first call the key decides, its second to the second, and no return past its end. A function is called with the call and the list of earlier calls, and it returns the scripted return. An earlier call that got no return, as the next paragraph says, has no `returned`. A `respond` function is called the same way for every call. Node loads a scenarios file once per command. So a value that the file keeps at its top level, such as a count that a `respond` function raises, carries over to each later scenario that uses the file, a scenario of another workflow that names the same file included.

The simulation stops when a call gets no usable scripted return: no key matches, a list is used up, a function returns `undefined`, or the return has the wrong type or holds a value that JSON cannot carry. It also stops at the call after the 1000th, since the runtime caps one workflow at 1000 `agent()` calls. The script runs no further, and a `try` around `agent()` does not catch the stop. A call made after the script settled stops nothing. When such a call gets no usable scripted return or comes after the 1000th, the trace records it with no `returned`. A script that waits on a promise that nothing settles also stops, since a run of it would not end. A script that reads a name the runtime defines and the running Node lacks, such as `Temporal`, stops before it runs. A script that breaks a rule of [`dwfb validate`](#dwfb-validate) is refused and does not run, and the command prints its findings.

The command prints one line per scenario, then the counts of passed and failed scenarios. A line gives how the simulation ended and how many calls it made, and a failed scenario's line starts with `FAILED`. A scenario passes when its simulation ends as `expect` says. A scenario whose simulation stops or whose script is refused fails. `--scenario <name>` runs one scenario of the file. With no script, the command runs the `out` of each workflow of the config file that has `scenarios` against that file. With a script and no `--scenarios`, the command reads the `scenarios` of the config file's workflow whose `out` is the script. `--config <path>` names another config file. The command exits 0 when every scenario passed, 1 when one failed and 2 for a usage error, such as a scenarios file that does not load or holds an unknown key. `--json` prints the result as one JSON object, with the trace of each simulation.

The simulator leaves out the check of `agentType` and `model` against the session, any check of a schema other than its root type, and a budget that grows by a different count at each call. A call of `workflow()` that names a workflow throws an Error with the message `workflow() is not simulated`. Time is virtual, so each `agent()` call answers before any timer runs and a wait of any length ends at once. Code after a script's first `await` has no time limit. So a loop there with no end keeps the simulation from ending, unless it calls `agent()` and waits for an `agent()` answer or a timer between those calls, since the simulation then stops at the cap on `agent()` calls. A wait for a promise that settles at once, such as `await null`, does not count.

## dwfb inspect

`dwfb inspect` runs a workflow script against one scenario, with no model call, and prints each event of the simulation in the order the script made it. An event is an `agent()` call, a `phase()` invocation or a log line. For the example of [`dwfb simulate`](#dwfb-simulate), run this command:

```
$ dwfb inspect .claude/workflows/review.js --scenarios workflows/review/scenarios.js --scenario "passes on round 2"
.claude/workflows/review.js passes on round 2: returned, 2 calls.
call 0 (label "review"): prompt of 32 characters, returned an object.
call 1 (label "review"): prompt of 32 characters, returned an object.
```

The first line gives how the simulation ended and how many calls it made, as a line of `dwfb simulate` does, with no `FAILED` mark. A call's line gives the phase the runtime groups it under, its `parallel()` or `pipeline()` group, the length of its prompt and the type of its return. A call has no return when the simulation stopped at it, or when the script had settled before the call and the call got no usable scripted return or came after the 1000th. A length counts UTF-16 code units, as the `length` of a JavaScript string does. A character that a terminal does not show, such as a tab in a log line, is written as its escape, such as `\u{0009}`, so that each event takes one line.

`--call <index>` prints one call in full, and the first call is 0:

```
$ dwfb inspect .claude/workflows/review.js --scenarios workflows/review/scenarios.js --scenario "passes on round 2" --call 1
call 1 (label "review") of .claude/workflows/review.js passes on round 2
phase: none
group: none
options:
{
  "label": "review",
  "schema": {
    "type": "object",
    "properties": {
      "verdict": {
        "type": "string"
      }
    },
    "required": [
      "verdict"
    ]
  }
}
prompt of 32 characters:
Review this change.
Fix the typo
returned:
{
  "verdict": "pass"
}
```

A scenarios file of one scenario needs no `--scenario`. With no `--scenarios`, the command finds the scenarios file as `dwfb simulate` does. A script that breaks a rule of [`dwfb validate`](#dwfb-validate) is refused, and the command prints its findings. The command exits 0 when it prints the simulation, also for a simulation that threw or stopped, 1 for a refused script and 2 for a usage error. `--json` prints the result as one JSON object.

## dwfb map

`dwfb map` runs a workflow script against each scenario of a scenarios file, with no model call, and writes the flow map of every path the scenarios reach. A flow map is a Markdown document with one Mermaid diagram and tables of the phases, loops, edges and end states. For the example of [`dwfb simulate`](#dwfb-simulate), the scenarios file gives each scenario the keys `when` and `endState`:

`workflows/review/scenarios.js`:

```js
export default [
  { name: 'passes', when: 'the first review passes', endState: 'review passed', args: { change: 'Fix the typo' }, respond: { review: { verdict: 'pass' } } },
  { name: 'passes on round 2', when: 'the first review fails', endState: 'review passed', args: { change: 'Fix the typo' }, respond: { review: [{ verdict: 'fail' }, { verdict: 'pass' }] } },
  { name: 'reviewer dies', when: 'the reviewer dies', expect: 'threw', args: { change: 'Fix the typo' }, respond: { review: null } },
];
```

```
$ dwfb map .claude/workflows/review.js --scenarios workflows/review/scenarios.js --out docs/review.flow-map.md
Wrote docs/review.flow-map.md.
```

`docs/review.flow-map.md`:

````markdown
# review flow map

Generated by `dwfb map`. Do not edit this file by hand.
Each node and edge below was reached by a scenario, so the diagram shows what the script does in a simulation.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 80, "rankSpacing": 200}}}%%
flowchart TD
  S0(["args"])
  a1["review"]
  t1(["review passed"])
  x1[/"throw: The reviewer died"/]
  S0 --> a1
  a1 -.->|"L1 ×2"| a1
  a1 --> t1
  a1 --> x1
```

## Phases

| Phase | What happens |
|---|---|

## Loops

| Loop | Agent | Repeats while |
|---|---|---|
| L1 | review | the first review fails |

## End states

| End state | Reached when | Source |
|---|---|---|
| review passed | the first review passes · the first review fails | scenario |
| throw: The reviewer died | the reviewer dies | throw (line 7) |
````

| Key | Meaning |
|---|---|
| `when` | The words that say when the scenario's path is taken, which the tables show. Defaults to the scenario's `name`. |
| `endState` | The end state of a scenario whose script returns no status. |

`dwfb simulate` and `dwfb inspect` ignore both keys.

The map reads each call's label as a role, then an item, then a round marker, with white space, `:` or `/` between them. In the label `review plan-a r2`, the role is `review`, the item is `plan-a` and the round marker is `r2`. The roles are the fixed starts of the `label` strings in the script, and each role is one node of the diagram. A step from one item to the next is a thick edge. A step back to a node that the path reached before is a dotted edge, and its count is one more than the most times one scenario took the step from one item, or in one branch of a `parallel()` or `pipeline()` group. A call whose label starts with no role leaves its scenario unmapped.

A script that returns an object whose `status` is a string ends in the end state of that status. A script that returns no status ends in the scenario's `endState`. Each run of digits in an end state is replaced by `N`, so `done (2 blocks)` and `done (3 blocks)` are one end state. A scenario whose `endState` differs from the status is unmapped, and so is a scenario whose script returns no status and that has no `endState`. A script that throws ends at the `throw new <Name>(...)` statement whose fixed message text is the longest start of the thrown message. A thrown message that starts with the fixed text of no such statement leaves its scenario unmapped.

A scenario whose simulation stops is unmapped too. For a script with an unmapped scenario, the command writes no file and prints one line per unmapped scenario. A script that breaks a rule of [`dwfb validate`](#dwfb-validate) is refused, and the command prints its findings before those lines. With a script and no `--scenarios`, the command finds the scenarios file as `dwfb simulate` does. With no `--out`, it writes the `map` of the config file's workflow whose `out` is the script, and it prints the flow map when `--scenarios` is given or no such `map` exists. With no script, it writes the `map` of each workflow of the config file that has one. `--config <path>` names another config file. The command writes no file whose bytes would not change, and it prints `Wrote <file>.` or `Unchanged <file>.` for each file. `--check` writes nothing and prints `Fresh` or `Stale` for each file. This way a commit hook can stop a flow map that no longer matches its script. `--json` prints the result as one JSON object, with the graph of each script and the findings of a refused script, and writes no file. The command exits 0 when every flow map is written, unchanged, printed or fresh, 1 for an unmapped scenario or a stale file and 2 for a usage error.

## License

MIT. See [LICENSE](LICENSE).

This project is independent. It is not affiliated with, sponsored by or endorsed by Anthropic.
