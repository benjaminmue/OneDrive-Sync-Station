// Which client log lines the log view hides while "hide routine lines" is on.
//
// Kept apart from app.js so the rules can be tested without a browser. Two
// kinds of line are routine: remote items the folder selection leaves alone,
// and the client's integrity check confirming, item by item, that nothing
// changed. The check prints a "Processing: <path>" line and its verdict on the
// next line; only a pair whose verdict is "has not changed" is hidden, so a
// processed item that did change keeps both lines.

const PROCESSING = /^Processing: /;
const UNCHANGED = /^The (?:file|directory) has not changed$/;

/**
 * Whether a log line is a remote item the folder selection deliberately skips.
 *
 * These dominate every sync that uses a selection: one line per excluded item,
 * repeated on each run. Lines about local files being left behind are
 * deliberately not matched, because those are the ones that matter.
 * @param {string} line A log line.
 * @returns {boolean} True when the line is skip noise.
 */
export function isSkipNoise(line) {
  return line.includes("Skipping path - ");
}

/**
 * Whether a line is the "nothing changed" verdict of the integrity check.
 * @param {string} line A log line.
 * @returns {boolean} True for the verdict.
 */
function isUnchanged(line) {
  return UNCHANGED.test(line.trimEnd());
}

/**
 * The buffered lines without the routine ones.
 * @template {{line: string}} T
 * @param {T[]} entries Log entries in order.
 * @returns {T[]} The entries worth showing.
 */
export function hideRoutine(entries) {
  const kept = [];
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i].line;
    if (isSkipNoise(line) || isUnchanged(line)) continue;
    if (PROCESSING.test(line) && i + 1 < entries.length && isUnchanged(entries[i + 1].line)) {
      i++;
      continue;
    }
    kept.push(entries[i]);
  }
  return kept;
}

/**
 * The same rule for lines arriving one at a time. A "Processing:" line is held
 * back until the next line says whether it is routine.
 * @template {{line: string}} T
 * @returns {(entry: T) => T[]} Takes the next entry, returns what to append now.
 */
export function routineLineFilter() {
  /** @type {T|null} */
  let held = null;
  return (entry) => {
    const out = [];
    if (held) {
      const previous = held;
      held = null;
      if (isUnchanged(entry.line)) return out;
      out.push(previous);
    }
    if (isSkipNoise(entry.line) || isUnchanged(entry.line)) return out;
    if (PROCESSING.test(entry.line)) {
      held = entry;
      return out;
    }
    out.push(entry);
    return out;
  };
}
