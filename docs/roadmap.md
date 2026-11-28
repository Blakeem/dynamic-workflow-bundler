# Roadmap

Items are built one at a time, in the order below. An item is done when three things hold:

1. Its tests pass.
2. The reference workflows give the same result as before. The reference workflows are seven production
   workflow scripts of 20 KB to 344 KB.
3. A defect review of the item found nothing left to fix.

Status is one of `planned`, `building` or `done`.

## Version 0.0.1: core

| Item | Command | Scope | Status |
|---|---|---|---|
| Bundle | `dwfb build`, `dwfb locate` | Build one workflow script from an entry, modules, text files and parts. `--check` reports a built script that no longer matches its source. `locate` maps a line of the built script to its source line. | done |
| Contract check | `dwfb validate`, `dwfb build` | Report each rule of the Workflow runtime that a script breaks, before launch. The build checks each script it builds and places a finding at its source line. | done |
| Simulator | `dwfb simulate` | Run a script against a scenario with no model call, under the same limits as the runtime. | done |
| Trace and inspector | `dwfb inspect` | Record every call of a simulation. Show one call's prompt, schema and return, and step through the calls in order. | done |

## Version 0.0.2 to 0.0.4: tools that exist and move here

| Version | Item | Command | Scope | Status |
|---|---|---|---|---|
| 0.0.2 | Flow map | `dwfb map` | Draw a Mermaid graph of every path the scenarios reach, with loops and end states. | done |
| 0.0.3 | Prompt snapshot | `dwfb snapshot` | Keep one copy of each distinct prompt per role, so a diff shows which prompts an edit reached. Hold a prompt budget per role. | done |
| 0.0.4 | Coverage | `dwfb cover` | List each role, throw site, declared end state and phase that no scenario reaches, and each phase that a scenario uses and `meta.phases` does not list. | building |

## Version 0.0.5 to 0.0.8: new tools

| Version | Item | Command | Scope | Status |
|---|---|---|---|---|
| 0.0.5 | Schema-valid returns | `dwfb simulate` | Reject a scripted return that breaks the call's schema. Build a minimal valid return from a schema. | planned |
| 0.0.6 | Dead-agent sweep | `dwfb sweep` | Repeat each scenario with one agent dead at a time. Report each simulation that still ends as a success. | planned |
| 0.0.7 | Runtime probe | `dwfb probe` | Write a script with no agent call that reports how the installed runtime behaves. Compare that report with the rules this tool holds. | planned |
| 0.0.8 | Child workflows | `dwfb simulate` | Simulate a `workflow()` call by running the child script inside the same simulation. | planned |

## Version 0.1.0: first release on npm

Every item above is done, and the package is published.

## Possible later features

- **Run replay:** load the journal of a real run and repeat it in the simulator.
- **Resume preview:** show which calls would run again after an edit to a script with a paused run.
- **Line coverage:** list the script lines that no scenario executes.
- **Script lints:** report a schema field that nothing reads, or a default that hides a dead agent.
- **TypeScript source.**
- **HTML viewer for a trace.**
- **Build at launch through a hook,** with no built script committed.
