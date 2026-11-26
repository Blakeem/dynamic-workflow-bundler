# dynamic-workflow-bundler

Build, validate and simulate dynamic workflow scripts for Claude Code.

A dynamic workflow is one JavaScript file. The Workflow runtime loads no second file, so a large workflow
is one long script, and two workflows cannot share code. This tool removes that limit at build time.

**Status:** in development and not yet on npm. The [roadmap](docs/roadmap.md) lists what is built.

## Commands

| Command | Purpose | Status |
|---|---|---|
| `dwfb build` | Build one workflow script from an entry, modules and text files. | planned |
| `dwfb validate` | Report each rule of the Workflow runtime that a script breaks, before launch. | planned |
| `dwfb simulate` | Run a script against scripted agent returns, with no model call. | planned |
| `dwfb inspect` | Show what each agent of a simulation received and returned. | planned |

## License

MIT. See [LICENSE](LICENSE).

This project is independent. It is not affiliated with, sponsored by or endorsed by Anthropic.
