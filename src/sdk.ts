/**
 * The package entry a module written outside boardlab imports: `import { BoardError } from 'boardlab'`. At run time
 * `boardd` resolves `boardlab` to its own built SDK (`dist/sdk.js`, from `core/sdk.ts`), so the classes are the ones the
 * core checks with `instanceof`; at build time this file gives a module's TypeScript the same values and types.
 *
 * A module's part of the page is built for the browser (`dist/sdk.browser.js`, see the distribution's `src/sdk.browser.ts`),
 * which exports the same helper names from `ui/contract.ts` and the page's own `call`.
 */
export * from './core/sdk.ts'
export { isRemoteGroup } from './shared/commands.ts'
export type { Command, CommandGroup, RemoteCommand, RemoteCommandGroup, RemoteContext } from './shared/commands.ts'
export { parseDuration } from './shared/duration.ts'
// Server side only, so not in `core/sdk.ts`, which the browser build re-exports: reading a host's console log, the
// database's transaction, a file's digest, and a line a board said it was waiting on a person for.
export { readLog } from './core/consoles.ts'
export { transaction } from './core/db.ts'
export { sha256File } from './core/files.ts'
export { askedIn } from './core/relay.ts'
// What a module's own command is handed by the CLI that runs it: a question on the terminal, a streamed answer, and
// where an agent's skills live. Server side — these touch stdin/stdout and the filesystem — so not in `core/sdk.ts`,
// which the browser build re-exports.
export { confirm, write } from './shared/terminal.ts'
export { installedAgentSkills, noAgentsMessage } from './shared/agents.ts'
export type { AgentSkillDestination, AgentSkills } from './shared/agents.ts'
// A catalog entry is a distribution's, not a module's: a module from a market has no entry, so the few helpers an
// entry's `create` uses to read its settings are here, for a module that reads them the same way. Lives in `shared`,
// because the SDK may not import `server`.
export { instances, number, text } from './shared/settings.ts'
export type { ModuleSettings } from './shared/settings.ts'
export type { CatalogEntry, ModuleContext } from './core/catalog.ts'
// Reaching another machine over ssh as boardd does it: one surface for every module that sets one up, wherever it came
// from. Server side only (it runs ssh), so not in `core/sdk.ts`, which the browser build re-exports.
export { Hosts, hostsFor } from './shared/ssh.ts'
export type { Access, Executor, Result } from './shared/ssh.ts'
// The module markets themselves: a module that lists markets, adds one, or changes which modules boardd loads (the
// market's own page) reads and writes them with these, rather than running git and parsing manifests itself. Server
// side only — `core/sdk.ts` is shared with the browser build, and this reads files and runs git.
export { digestOf, marketsDir, marketsFile, marketsOnDisk, readMarket, readRecords, syncMarket, uiPartsOf, writeRecords } from './core/module-markets.ts'
export type { MarketModule, MarketRecord, ModuleMarket } from './core/module-markets.ts'
// The client library, for a module that talks to another boardd — a hub forwarding to the boardd of a board host. Server
// side: it opens sockets. A module's page part imports `boardlab/ui`; this is `boardlab`'s client.
export { BoardsApiError, BoardsClient, DEFAULT_PORT, defaultStateDir, defaultTransport, remoteConfigPath, socketPathFor, transportFor, unixTransport } from './shared/client.ts'
export type { Transport, RemoteConfig } from './shared/client.ts'
