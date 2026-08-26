// Bounded, timestamped line buffer. Every sync instance owns one so the UI can
// tail recent client output without us writing log files of our own.

import { localTimestamp } from "./time.js";

/**
 * @typedef {{ts: string, line: string}} LogEntry
 */

/**
 * Create a bounded FIFO buffer of timestamped log lines.
 * @param {number} [limit] Maximum number of retained lines.
 * @returns {{push: (chunk: string) => LogEntry[], pushEntry: (entry: LogEntry) => void, list: () => LogEntry[], clear: () => void}} The buffer.
 */
export function createRingBuffer(limit = 400) {
  /** @type {LogEntry[]} */
  const items = [];

  /**
   * Append one ready-made entry, dropping the oldest when full.
   * @param {LogEntry} entry Timestamped line.
   * @returns {void}
   */
  function pushEntry(entry) {
    items.push(entry);
    if (items.length > limit) items.shift();
  }

  return {
    pushEntry,

    /**
     * Split a raw output chunk into lines, timestamp them and append them.
     * @param {string} chunk Raw output, possibly several lines.
     * @returns {LogEntry[]} The entries that were appended.
     */
    push(chunk) {
      const added = [];
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue;
        const entry = { ts: localTimestamp(), line };
        pushEntry(entry);
        added.push(entry);
      }
      return added;
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
