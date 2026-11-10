# Repository Guidelines

## What this is

boardlab-core is the core of boardlab: boardd's core (kernel and subsystems), the backend contract, the HTTP gateway, the CLI framework and the client library. It has no web page: distributions bring their frontends. Distributions consume it as a git submodule plus a pnpm workspace package and add modules; see `README.md`.

- `src/core`: the kernel (database, events, action log, settings) and its subsystems (locks, boards, backends, relay, consoles, download, files, proposals, the API registry). It knows backends only through the `Backend` contract and names no product.
- `src/server`: boardd: the module catalog interface, `boardd.json` configuration, and the HTTP gateway.
- `src/cli`: the CLI framework (`createCli`), the core's commands, and `serve`.
- `src/shared`: the client library and the types the CLI, the page and other programs share.
- `bare/`: the bare distribution, the core with no modules.
- `scripts/`: the architecture check and the build, which distributions run on themselves.
- `architecture.json`: the layering. Change the rules there, not around them.

## Public repository

- This repository is public. It holds no distribution's modules and nothing site-specific: no host names, addresses, internal URLs, credentials, tokens, personal information or logs.
- `internal/` holds local, private materials. Never commit or publish any part of it, and keep the `/internal/` rule in `.gitignore`.
- Do not commit state databases, CLI tokens, dependencies or build output. Before committing, inspect `git diff --cached --name-only` and the staged content.

## Changing the core

- Something only one kind of hardware needs belongs in a distribution's module, not here. The core grows by generalising the contract.
- Keep the core usable by every distribution: a change to an exported interface (`Backend`, `Module`, `CatalogEntry`, `Distribution`, the client, the frontends served) is a change to all of them. Say so in the commit body.

## Branches and commits

- Develop every change on a dedicated branch, never directly on `main`. Before merging, rewrite the branch into clean commits, each complete and working on its own.
- Use a concise subject and a short body describing the final change and its purpose.
- End every commit message with the repository owner's own `Signed-off-by` trailer only. Never add AI attribution trailers such as `Co-Authored-By`.
- Every commit must carry an OpenPGP signature made with the configured signing key. Verify with `git verify-commit`. If signing fails, report it instead of committing unsigned.
- Keep this file in English.

## Validation

```sh
pnpm install
pnpm run typecheck
pnpm check
pnpm run build
pnpm test
```

Tests use fake backends only, never real hardware.
