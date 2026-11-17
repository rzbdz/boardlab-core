/**
 * Debugging a board as a first-class thing: halt, run, reset, step, registers, a live trace channel, a GDB
 * endpoint. A backend reports which debug paths its boards have (each with the provider's own title and what it
 * offers) and runs them; core carries the shape and the page renders it. Nothing here knows an adapter, a probe, a
 * protocol or a transport: a board debugged over a probe and one debugged over two GPIO pins look the same.
 */
import type { Backend, BoardTarget, LabConfig } from './backend.ts'
import type { ConsoleSession } from './console.ts'
import type { DebugPath, DebugResult } from '../shared/types.ts'

export type { DebugPath, DebugResult } from '../shared/types.ts'

/** For a backend whose boards can be debugged. */
export interface DebugCapability {
  /** The board's debug path, if it has one; null for a board with none. */
  path(config: LabConfig, target: BoardTarget): Promise<DebugPath | null>
  /** Bring the session up (it lives under the board's lock) and say where it is. */
  start(config: LabConfig, target: BoardTarget): Promise<DebugPath>
  stop(config: LabConfig, target: BoardTarget): Promise<string>
  /** Run one of the `kinds` the path reports. */
  action(config: LabConfig, target: BoardTarget, action: string): Promise<DebugResult>
  /**
   * The session's bytes (a trace channel): a console-like session the page shows as it arrives. It is the
   * provider's stream, not a serial console; boards whose real console is the same channel share the bytes.
   */
  stream?(config: LabConfig, target: BoardTarget): Promise<ConsoleSession>
}

export const DEBUG_ACTIONS = ['halt', 'run', 'reset', 'step', 'regs'] as const
