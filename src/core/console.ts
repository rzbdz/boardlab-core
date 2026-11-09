/** A session on a board's serial console, whichever backend carries it (serial-mux here, a lab's reader elsewhere). */
export interface ConsoleHello { alias: string, device: string | null, baud: number, transport: string }

export interface ConsoleSession {
  hello: ConsoleHello
  /** Recent output from before the session opened, a line each. */
  history: string[]
  send(data: string | Uint8Array): void
  onOutput(listener: (data: Buffer) => void): () => void
  onClose(listener: (reason: string) => void): void
  close(): void
}
