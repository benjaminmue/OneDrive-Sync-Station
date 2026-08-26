// Bounded, timestamped line buffer. Every sync instance owns one so the UI can
// tail recent client output without us writing log files of our own.

import { localTimestamp } from "./time.js";

/**
 * Create a bounded FIFO buffer of timestamped log lines.
 * @param {number} [limit] Maximum number of retained lines.
 * @returns {{push: (chunk: string) => void, list: () => Array<{ts: string, line: string}>, clear: () => void}}
 */
export function createRingBuffer(limit = 400) {
  const items = [];
  return {
    /** Split a raw stdout chunk into lines and append them. */
    push(chunk) {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue;
        items.push({ ts: localTimestamp(), line });
        if (items.length > limit) items.shift();
      }
    },
    /** Snapshot of the retained lines, oldest first. */
    list() {
      return items.slice();
    },
    /** Drop all retained lines (used when an instance is deleted or reset). */
    clear() {
      items.length = 0;
    },
  };
}
