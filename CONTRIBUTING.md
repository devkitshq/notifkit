# Contributing to notifkit

Thanks for helping. Bug reports, fixes, docs, new providers and examples are all welcome.

## Before you start

- **Small fix or docs change?** Open a PR directly.
- **New feature or a change to how delivery works?** Open an issue first so we can agree on the approach before you spend time on it.
- **Looking for something to do?** Check issues labelled [`good first issue`](https://github.com/devkitshq/notifkit/labels/good%20first%20issue) or [`help wanted`](https://github.com/devkitshq/notifkit/labels/help%20wanted). Comment on the issue so nobody else picks it up at the same time.

## Setup

You need Node 22+, npm 10+, and Docker running. The tests start their own PostgreSQL and Redis containers, so you don't have to install either.

```bash
git clone https://github.com/devkitshq/notifkit.git
cd notifkit
npm install
npm install --prefix dashboard   # the dashboard has its own lockfile
npm run build
npm run build:dashboard
npm test
```

## Project layout

| Path                        | What's there                                                                 |
| --------------------------- | ---------------------------------------------------------------------------- |
| `src/`                      | The core: API server, engine, workers, queue, rate limiter, DB               |
| `src/contracts/`            | Zod schemas for events, channels and preferences                             |
| `src/db/`, `drizzle/`       | Drizzle schema and SQL migrations                                            |
| `dashboard/`                | Admin dashboard (React, built separately)                                    |
| `packages/provider-*`       | One package per delivery provider (Resend, Twilio, Slack, …)                 |
| `packages/mcp/`             | MCP server so AI agents can drive notifkit                                   |
| `packages/create-notifkit/` | The `npm create notifkit` scaffolder                                         |
| `examples/`                 | Runnable example apps                                                        |
| `tests/`                    | Unit tests at the top level; `integration/` and `chaos/` use real containers |

## Checks to run

CI runs these on every PR, so run them before pushing:

```bash
npm run typecheck
npm run lint
npm test
```

To run a single file while you work: `npx vitest run tests/queue.test.ts`, or `npm run test:watch`.

If you change a workspace package, also run `npm run typecheck:workspaces`.

## Writing a change

- **Bug fixes come with a test.** Write a test that fails without your fix and passes with it. `tests/regressions.test.ts` is a good home if nothing else fits.
- **Schema changes need a migration.** Edit `src/db/` and generate a migration with `npx drizzle-kit generate`. Don't edit old files in `drizzle/`.
- **Keep it small.** One PR does one thing. Refactors go in a separate PR from behaviour changes.
- Prettier and ESLint run on commit via husky and lint-staged. If a hook fails, fix the issue rather than skipping it.

## Adding a provider

Copy an existing provider package (`packages/provider-slack` is a compact one), rename it, and implement the transport in `src/index.ts`. Add a `README.md` showing how to configure it, and a test in `tests/providers.test.ts`.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/), checked by commitlint. Changelogs and version bumps come from these messages, so they matter.

```
<type>(<scope>): <subject in lower case, no trailing period>
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`.

Examples from the history:

```
fix(workflow): only reap instances that are still running
feat(config): raise the SEGMENT_MAX_USERS default to 100,000
docs(readme): add a production support section
```

Use `feat` and `fix` only for changes users will notice, since those appear in the changelog.

## Pull requests

- Target `main`.
- Explain what changed and why. Link the issue if there is one.
- CI must be green. Releases are automated with release-please, so don't bump versions or edit `CHANGELOG.md` yourself.

## Questions

Open an issue or email [contact.devkitshq@gmail.com](mailto:contact.devkitshq@gmail.com).

By contributing, you agree your work is licensed under the [MIT License](./LICENSE).
