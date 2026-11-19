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
  private readonly answers: Array<Promise<unknown>> = []
  /** Why the backend would not stop, once every ask it handed over was refused: the run goes on, and is not cancelled. */
  refused: Error | null = null
  constructor(message: string) { super('cancelled', message.startsWith('已取消') ? message : `已取消：${message}`) }
  /**
   * A backend that stops a run by asking something else to stop it (a host's job) hands over that ask when the run's
   * signal aborts with this cancel: whoever cancelled then learns whether it was refused (`answered`).
   */
  answer(asked: Promise<unknown>) { asked.catch(() => {}); this.answers.push(asked) }
  /**
   * Resolves once one ask handed over was taken, or at once when none was; rejects with the first refusal when every
   * one was refused (`refused`).
   */
  async answered(): Promise<void> {
    if (!this.answers.length) return
    try { await Promise.any(this.answers) } catch (error) {
      const first = ((error as AggregateError).errors?.[0] ?? error) as Error
      this.refused = first
      throw first
    }
  }
}

/** Whether `error` (or the abort of `signal`) is a cancellation rather than a failure. */
export function isCancelled(error: unknown, signal?: AbortSignal | null): boolean {
  return error instanceof CancelledError || (!!signal?.aborted && signal.reason instanceof CancelledError && !signal.reason.refused)
}
