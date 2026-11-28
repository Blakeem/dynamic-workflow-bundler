# dynamic-workflow-bundler (for Claude)

A command line tool and library for authors of Claude Code dynamic workflows. It builds one workflow script
from several source files, checks the script against the rules the Workflow runtime enforces, and runs the
script against scripted agent returns with no model call.

`docs/roadmap.md` holds the build order and each version's scope. Build one roadmap item at a time. An item
is done when its tests pass, the reference workflows give the same result as before, and a defect review of
the item found nothing left to fix.

## Vocabulary

One word per concept, in code, commands, messages and docs. Never use a second word for a listed concept.

| Word | Meaning |
|---|---|
| workflow script | The one file the Workflow runtime runs. It opens with `export const meta`. |
| source | The files a workflow script is built from. |
| entry | The source file that holds `meta` and the top-level body. |
| module | A source file that uses `import` or `export`. |
| text file | A file imported as a string of its content. |
| JSON file | A file imported as the value `JSON.parse` gives for its content. |
| part | A source file joined into the script as text, in a stated order. |
| build | To write a workflow script from its source. The result is the built script. |
| scope | The function scope that holds one module's code in the built script. |
| banner | The comment line after `meta` that names the entry a built script comes from. A build replaces an existing file at `out` only when it is a built script, which a banner marks, or for a build with no banner a first statement that is the `meta` statement. |
| directive | A line comment that starts with @ and a word the tool reads. `// @include <path>` in an entry names a part. `// @end-states` on the line above a const declares the end states it lists. `// @unreached <reason>` on the line above a throw site or a label marks a throw site or a role that no scenario can reach. |
| config file | The `dwfb.config.js` or `dwfb.config.mjs` file, which lists the workflows a project builds. |
| line origin | The source file and line that a line of the built script comes from. |
| contract | The rules the Workflow runtime enforces on a script. |
| rule | One entry of the contract, with an id and the Claude Code version it was measured on. |
| finding | One place where a script or a source breaks a rule. |
| scenario | The args and the scripted agent returns for one simulation. |
| scenarios file | The ES module whose default export lists the scenarios of one script, each with a name and the end that passes it. |
| simulation | One execution of a script against a scenario. A run is a real execution by the runtime. |
| trace | The record of one simulation. |
| call | One `agent()` invocation in a trace. |
| phase | The title the runtime groups a call under. `phase()` sets it for the calls after it, and a call's `phase` option sets it for that call alone. |
| event | One call, `phase()` invocation or log line of a trace. A trace lists its events in the order the script made them. |
| inspection | What `dwfb inspect` shows of one trace: its events in order, or one call in full. |
| role | The fixed start of a call's label, which names the kind of agent, such as `review` in `review:u1`. |
| item | The part of a call's label after its role that names what the call works on, such as `u1` in `review:u1`. |
| throw site | One `throw new <Name>(...)` statement of a script, placed at the line and column of its `new` keyword. |
| frame | One place in a script that the stack of a thrown error names: a line and a column. The newest frame is where the error was created. |
| call site | One entry of the stack that V8 records for an error, with a file name and an offset into the compiled code. Each call site inside the script gives one frame. |
| end state | A named way a script ends: the `status` of the object it returns, the name a scenario gives, or a throw site. |
| coverage | Which roles, throw sites, declared end states and phases of one script its scenarios reach. |
| reach | A scenario reaches a role when its simulation makes a call of the role, a throw site when its simulation ends with an error whose newest frame is the site, a declared end state when its simulation ends in it, and a phase when a call of its simulation runs under it. |
| flow map | The graph of every path that the scenarios of one script reach, written as a Mermaid diagram with tables. |
| node | One box of a flow map: the start, a role, an end state or a throw site. |
| edge | One step of a flow map, from a node to the node a path reaches next. |
| context | The top level of a trace, or one lane of a group, with the calls it made and the groups it started. |
| segment | A part of the calls of one context that a flow map folds as one unit: a run of its own calls, or the groups it started that ran at the same time. |
| lane | The calls of one item of a group. |
| context chain | A context with each context that encloses it, up to the top level of the trace. |
| chain length | The count of calls along a context chain before a call, where a segment of groups counts the calls of its longest lane. |
| back edge | An edge into a node that the path first reached no later than the node the edge leaves, which closes a loop. A join out of a lane counts only the nodes that the lane or the path before its group reached. |
| next-item edge | An edge between two calls whose items differ, the step from one item of work to the next. |
| loop | A back edge, with the count of times one lane walks it. |
| prompt snapshot | The document that holds one copy of each variant of one script. A diff of it shows which prompts an edit reached. |
| variant | One distinct prompt of a role. Two prompts of one role are one variant when they have one schema and are equal once the item, each UUID, each lowercase hex word of 8 or more characters and each number are masked. |
| prompt budget | The most characters that the largest prompt of one role may hold. It is never shortened to `budget`, which names the numbers a script reads from the runtime. |
| document | A flow map or a prompt snapshot, which a command writes for one script from its scenarios. Its kind says which of the two it is, and its document file is the file that holds it. |
| generated mark | The start of the third line of a document, such as ``Generated by `dwfb map`.``, which names the command that writes its kind. A command replaces an existing document file only when it holds the mark of its kind. |
| prompt digest | One hash of the label, the prompt and the schema of every call of every scenario. Two scripts have one digest only when their calls, in scenario file order and then in call order, have the same labels, prompts and schemas. |
| scripted return | The value a scenario gives one call. `null` stands for an agent that died. An object for a call with a schema passes that schema. |
| minimal return | The object that `createReturn()` makes for a schema: the values the caller gives, and for each required key it lacks the smallest value of its schema. |
| stop | The end of a simulation that cannot go on: at a call that gets no usable scripted return, at the call after the runtime's cap on `agent()` calls, when the script waits on a promise that nothing settles, or before a script that reads a name the running Node lacks. |
| group | One `parallel()` or `pipeline()` invocation in a simulation. Each call made inside it records the group's index. |
| runtime | The Claude Code Workflow runtime. The simulator is this project's stand-in for it. |

Add a row before a new concept gets a name in code.

## Names

- **Package:** `dynamic-workflow-bundler`. **Command:** `dwfb`. **Config file:** `dwfb.config.js` or
  `dwfb.config.mjs`. A command that needs the config file stops when both exist.
- **No Anthropic mark in a name.** Never put "Claude", "Claude Code" or "Anthropic" in a package, command,
  file, export or option name. Say "Claude Code" only in plain descriptive text.
- **Commands are one plain verb:** `build`, `validate`, `locate`, `simulate`, `inspect`, `map`, `snapshot`, `cover`. A new command takes
  a verb that no existing command could be mistaken for.
- **The library exports each command's verb** as a function, such as `build()` and `locate()`.
- **Options are full words in kebab-case:** `--out`, `--check`, `--json`. A one-letter alias exists only for
  an option typed in most invocations.
- **Files are kebab-case `.js`.** One job per file. A file is named for the thing it holds, such as
  `join-modules.js`, never for its layer, such as `utils.js` or `helpers.js`.
- **Functions are verb then noun in camelCase:** `readSource`, `joinModules`. A function that returns a
  boolean starts with `is` or `has`.
- **Constants are UPPER_SNAKE_CASE.** A rule id is kebab-case and says what is wrong, such as
  `meta-not-first` or `script-too-large`.
- **No abbreviation** in a name, except `args`, `opts`, `src`, `dir` and `id`.

## Command behavior

- **Output is for a person by default and for a program with `--json`.** Every command supports `--json`,
  and its shape is part of the public interface.
- **A finding prints as** `<file>:<line>:<column> <rule id> <what is wrong>. <how to fix it>.`
- **Exit codes:** 0 for success, 1 when the command found a problem in the user's files, 2 for a usage
  error or an internal failure.
- **Results go to stdout. Progress and diagnostics go to stderr.**
- **Output is byte-stable.** No timestamp, no absolute path, no random value, so that output can be
  committed and compared.
- **A command never writes outside the paths the user named.** A build writes to a temporary file and
  renames it, so a failed build leaves the previous script in place.
- **Refuse, never guess.** When the tool cannot prove that a built script behaves as its source does, it
  stops with a finding.

## Code

- JavaScript for Node 22 and later, ES modules. The dependencies are the `acorn` parser and the `ajv` JSON
  Schema validator, each pinned to an exact version. Read code structure from the syntax tree of `acorn`,
  never from a text pattern, since a pattern also matches inside a prompt string. `ajv` checks a call's
  schema and a scripted return as the runtime checks them, and of the files under `src/` and `bin/`,
  `src/compile-schema.js` alone imports it. Add no other dependency.
- Types go in JSDoc comments.
- Files that read or write disk, or print, stay separate from files that compute.
- Tests use `node:test` and sit in `tests/`, one file per source file, named `<source file>.test.js`.
  Fixtures sit in `tests/fixtures/`. `npm test` is the gate.
- A test of a property of the entire build, such as parity with ES modules, is one file named
  `<property>.test.js`. A helper that several test files share sits in `tests/support/`.
- A test of a rule holds one script that breaks the rule and one that passes it.
- The command runs on Windows, Linux and macOS, and `npm test` runs on one of them at a time. A branch for
  one platform carries a test that runs on that platform and is skipped with its reason on the others. A
  check on a path says in a comment which platform's rules it applies and who wrote the path.
- Every fact about the runtime that the code relies on carries the Claude Code version it was measured on.
  The runtime is partly undocumented and changes between releases.

## Versions

- Each roadmap item that lands raises the patch version. `docs/roadmap.md` records the version of each item.
- `package.json` stays `"private": true` until version 0.1.0, which is the first npm release. The owner
  publishes it.
- Each version gets a git tag `v<version>`.
