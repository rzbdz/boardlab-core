/** The one error type the core raises; its code says what went wrong in terms every transport can map. */
export type BoardErrorCode = 'not-found' | 'invalid' | 'locked' | 'forbidden' | 'conflict' | 'hardware' | 'cancelled'

export class BoardError extends Error {
  constructor(readonly code: BoardErrorCode, message: string) { super(message) }
}

/** An operation refused because the board is busy with another one (`Kernel.doing`): nothing of it started. */
export class BusyError extends BoardError {
  constructor(message: string) { super('conflict', message) }
}

/**
 * An operation someone cancelled (`Kernel.cancel`), or one its backend reports it stopped because it was asked to:
 * not a success and not a failure of the hardware. Its message starts with 已取消, and so does the action it records.
 */
export class CancelledError extends BoardError {
  constructor(message: string) { super('cancelled', message.startsWith('已取消') ? message : `已取消：${message}`) }
}

/** Whether `error` (or the abort of `signal`) is a cancellation rather than a failure. */
export function isCancelled(error: unknown, signal?: AbortSignal | null): boolean {
  return error instanceof CancelledError || (!!signal?.aborted && signal.reason instanceof CancelledError)
}
