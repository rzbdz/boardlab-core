# boardlab-core

The core of [boardlab](https://github.com/rzbdz/better-boardlab), a shared lab for development boards. People and AI agents lock boards, reset them, open their serial consoles and boot them from RAM, through one service and one command line.

boardlab-core holds what every boardlab has:

- **boardd**, the service: board inventory, locks with a queue, an action log, serial consoles, RAM boot, and an HTTP API.
- **The backend contract**: how boardd reaches boards (reset, serial console, download port), whether they are wired to this machine or sit in a remote lab.
- **The `boardlab` CLI** and **the web page**.
- **A client library** for other programs.

Backends, slot drivers and their commands come as modules, in a distribution such as [better-boardlab](https://github.com/rzbdz/better-boardlab). Run boardlab from a distribution.

## Building a distribution

A distribution adds boardlab-core as a git submodule at `core/` and as the pnpm workspace package `boardlab-core`. Each of its modules registers itself with boardd and may add CLI commands and a page section:

```ts
// src/boardlab.ts
import { createCli, runIfMain } from 'boardlab-core/cli/main.ts'
const cli = createCli({ groups: [myCommands], catalog: [myModule] })
export const main = cli.main
runIfMain(cli, import.meta.url)

// src/page.tsx
import { mountPage } from 'boardlab-core/ui/main.tsx'
mountPage([myModuleUi])
```

Build it with `node core/scripts/build.mjs --cli src/boardlab.ts --page src/page.tsx`. Check its layering with `node core/scripts/check-architecture.mjs`.

## Development

Requires Node.js 24 or newer and pnpm.

```sh
pnpm install
pnpm run typecheck
pnpm check
pnpm test
```

## Origin and changes

boardlab started as a single project by [Troy Mitchell](https://github.com/TroyMitchell911), released under the MIT license, whose notice is kept in [LICENSE](LICENSE). boardlab-core comes out of a substantial rework of that project. The major changes from the original:

- **A core with no products in it.** boardd's core (locks, inventory, slots, consoles, RAM boot, the API) knows backends only through one backend contract, and an architecture check enforces this.
- **Modules.** Every backend, slot driver, command group and page section is a module that registers itself with the core.
- **Distributions.** A boardlab you run is boardlab-core plus a chosen set of modules, so different labs ship different module sets without forking the core.
- **Remote labs and slots.** Boards in remote labs, slots that keep a board's identity when it is swapped, and backends that boot boards from their own media.

## License

MIT, see [LICENSE](LICENSE).
