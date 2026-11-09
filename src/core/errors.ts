/** The one error type the core raises; its code says what went wrong in terms every transport can map. */
export type BoardErrorCode = 'not-found' | 'invalid' | 'locked' | 'forbidden' | 'conflict' | 'hardware'

export class BoardError extends Error {
  constructor(readonly code: BoardErrorCode, message: string) { super(message) }
}
