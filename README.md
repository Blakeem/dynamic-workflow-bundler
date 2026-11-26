# dynamic-workflow-bundler

Build, validate and simulate dynamic workflow scripts for Claude Code.

A dynamic workflow is one JavaScript file. The Workflow runtime loads no second file, so a large workflow
is one long script, and two workflows cannot share code. This tool removes that limit at build time.

**Status:** in development and not yet on npm. The [roadmap](docs/roadmap.md) lists what is built.

## Planned commands

| Command | Purpose |
|---|---|
| `dwfb build` | Build one workflow script from an entry, modules and text files. |
| `dwfb validate` | Report each rule of the Workflow runtime that a script breaks, before launch. |
| `dwfb simulate` | Run a script against scripted agent returns, with no model call. |
| `dwfb inspect` | Show what each agent of a simulation received and returned. |

## License

MIT. See [LICENSE](LICENSE).

This project is independent. It is not affiliated with, sponsored by or endorsed by Anthropic.
