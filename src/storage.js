// Durable reads and writes for the station's own state files.
//
// Two rules everything here exists to enforce:
//
//   1. Never leave a half-written file behind. `writeFileSync` truncates first,
//      so a power cut or an OOM kill in the middle of a write leaves a valid
//      but truncated file. For a sync_list that silently deselects folders, and
//      the next resync then removes their local copies. Writing to a temporary
//      file and renaming makes the swap atomic on the same filesystem.
//
//   2. Never confuse "file is missing" with "file is unreadable". A missing
//      settings file means a fresh install and the first-run screen. A corrupt
//      one must not be treated the same way, because that screen hands the
//      station to whoever reaches it first.

import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";

/**
 * Write a file atomically: full contents to a temporary file in the same
 * directory, then rename over the target.
 * @param {string} file Target path.
 * @param {string} contents File contents.
 * @param {{mode?: number}} [opts] File mode for the created file.
 * @returns {void}
 */
export function writeFileAtomic(file, contents, opts = {}) {
  const temp = `${file}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: opts.mode ?? 0o600 });
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Read and parse a JSON state file.
 *
 * The three outcomes are kept apart deliberately so callers can react to each:
 * a missing file is a normal fresh state, a corrupt file is an error the
 * operator has to see, and a valid file yields its data.
 *
 * @param {string} file Path to read.
 * @returns {{status: "missing"|"corrupt"|"ok", data?: unknown, error?: Error}} The outcome.
 */
export function readJsonFile(file) {
  if (!existsSync(file)) return { status: "missing" };
  try {
    return { status: "ok", data: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { status: "corrupt", error };
  }
}
