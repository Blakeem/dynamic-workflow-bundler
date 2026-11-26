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
| text file | A file that is not JavaScript, imported as a string. |
| part | A source file joined into the script as text, in a stated order. |
| build | To write a workflow script from its source. The result is the built script. |
| contract | The rules the Workflow runtime enforces on a script. |
| rule | One entry of the contract, with an id and the Claude Code version it was measured on. |
| finding | One place where a script or a source breaks a rule. |
| scenario | The args and the scripted agent returns for one simulation. |
| simulation | One execution of a script against a scenario. A run is a real execution by the runtime. |
| trace | The record of one simulation. |
| call | One `agent()` invocation in a trace. |
| runtime | The Claude Code Workflow runtime. The simulator is this project's stand-in for it. |

Add a row before a new concept gets a name in code.

## Names

- **Package:** `dynamic-workflow-bundler`. **Command:** `dwfb`. **Config file:** `dwfb.config.js`.
- **No Anthropic mark in a name.** Never put "Claude", "Claude Code" or "Anthropic" in a package, command,
  file, export or option name. Say "Claude Code" only in plain descriptive text.
- **Commands are one plain verb:** `build`, `validate`, `locate`, `simulate`, `inspect`. A new command takes
  a verb that no existing command could be mistaken for.
- **The library exports the same verbs** as functions: `build()`, `validate()`, `simulate()`.
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

- JavaScript for Node 22 and later, ES modules. The one dependency is the `acorn` parser, pinned to an exact
  version. Read code structure from its syntax tree, never from a text pattern, since a pattern also matches
  inside a prompt string. Add no other dependency.
- Types go in JSDoc comments.
- Files that read or write disk, or print, stay separate from files that compute.
- Tests use `node:test` and sit in `tests/`, one file per source file, named `<source file>.test.js`.
  Fixtures sit in `tests/fixtures/`. `npm test` is the gate.
- A test of a rule holds one script that breaks the rule and one that passes it.
- Every fact about the runtime that the code relies on carries the Claude Code version it was measured on.
  The runtime is partly undocumented and changes between releases.

## Versions

- Each roadmap item that lands raises the patch version. `docs/roadmap.md` records the version of each item.
- `package.json` stays `"private": true` until version 0.1.0, which is the first npm release. The owner
  publishes it.
- Each version gets a git tag `v<version>`.
