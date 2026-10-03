/** Captures the JSON log lines of a test app (pino destination) for assertions on logging behaviour. */
import type { DestinationStream } from 'pino';

export type LogLine = Record<string, unknown> & { level?: string; msg?: string };

export interface LogCapture {
  readonly stream: DestinationStream;
  /** Parsed lines captured so far (bounded to the most recent `capacity`). */
  lines(): LogLine[];
  find(predicate: (line: LogLine) => boolean): LogLine[];
  clear(): void;
}

export function createLogCapture(capacity = 5000): LogCapture {
  const raw: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        raw.push(chunk);
        if (raw.length > capacity) raw.shift();
      },
    },
    lines() {
      return raw.flatMap((chunk) =>
        chunk
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as LogLine),
      );
    },
    find(predicate) {
      return this.lines().filter(predicate);
    },
    clear() {
      raw.length = 0;
    },
  };
}
