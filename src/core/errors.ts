/** The one error type the core raises; its code says what went wrong in terms every transport can map. */
export type BoardErrorCode = 'not-found' | 'invalid' | 'locked' | 'forbidden' | 'conflict' | 'hardware'

export class BoardError extends Error {
  constructor(readonly code: BoardErrorCode, message: string) { super(message) }
}

/** An operation refused because the board is busy with another one (`Kernel.doing`): nothing of it started. */
export class BusyError extends BoardError {
  constructor(message: string) { super('conflict', message) }
}
