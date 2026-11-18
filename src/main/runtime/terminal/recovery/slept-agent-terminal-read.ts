import type { RuntimeTerminalRead } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { readTerminalTail } from '../output/tail/terminal-tail-read'

/** A slept agent reads as an idle one: its stopped process's kept output, still running. */
export function readSleptAgentTerminal(
  handle: string,
  pty: RuntimePtyWorktreeRecord | null,
  opts: { cursor?: number; limit?: number },
  readPty: (pty: RuntimePtyWorktreeRecord) => RuntimeTerminalRead
): RuntimeTerminalRead {
  const read = pty
    ? readPty(pty)
    : readTerminalTail({
        handle,
        status: 'running',
        previewLines: [],
        completedLines: [],
        partialLine: '',
        completedLineCount: 0,
        bufferTruncated: false,
        cursor: opts.cursor,
        limit: opts.limit
      })
  return { ...read, status: 'running', source: 'stream' }
}
