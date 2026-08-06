/**
 * Public host-recording event vocabulary emitted by a Web IDE instance.
 *
 * Event names intentionally match Nova's existing session traces. Keeping the
 * vocabulary here lets hosts validate payloads at compile time without taking
 * a dependency on React, Zustand, or any workbench implementation detail.
 */

/** Host-owned trace label; `standalone` is the only core-defined value. */
export type IDESessionMode = 'standalone' | (string & Record<never, never>)

export type EmptyEventPayload = Record<string, never>

export interface IDEEventMap {
  session_start: { mode: IDESessionMode; files: Record<string, string> }
  edit: {
    file: string
    length: number
    content: string
    truncated?: boolean
  }
  compile: EmptyEventPayload
  compile_debug: EmptyEventPayload
  compile_test: EmptyEventPayload
  compile_error: { debug: boolean }
  run: { debug: boolean }
  run_tests: { debug: boolean }
  breakpoint_toggle: { file: string; line: number; on: boolean }
  breakpoints_validated: { file: string; lines: number[] }
  debug_step_into: EmptyEventPayload
  debug_step_over: EmptyEventPayload
  debug_step_out: EmptyEventPayload
  debug_continue: EmptyEventPayload
  debug_restart: EmptyEventPayload
  debug_step_back: EmptyEventPayload
  debug_step_forward: EmptyEventPayload
  debug_paused: {
    file: string | null
    line: number | null
    func: string | null
  }
  file_create: { path: string; kind: 'file' | 'folder' }
  file_rename: { from: string; to: string }
  file_delete: { path: string }
  terminal_stdout: { text: string; stream?: 'stdout' | 'stderr' }
  program_exit: { code: number }
}

export type IDEEventType = keyof IDEEventMap

export type IDEEvent = {
  [K in IDEEventType]: { type: K; payload: IDEEventMap[K] }
}[IDEEventType]

export interface IDEEventSink {
  <K extends IDEEventType>(type: K, payload: IDEEventMap[K]): void
}

export interface EventSource<T> {
  subscribe(listener: (event: T) => void): () => void
}
