// sync_list handling.
//
// The client reads a plain text file named `sync_list` from its config
// directory and syncs only what the rules there select. We own the file: the UI
// edits it, we validate and write it, and the caller triggers the resync the
// client requires after every change.

import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { instanceConfDir } from "./config.js";
import { writeFileAtomic } from "./storage.js";
import * as validate from "./validate.js";

const FILE_NAME = "sync_list";

/**
 * Absolute path of the sync_list of an instance.
 * @param {object} instance Instance record.
 * @returns {string} Absolute path.
 */
function filePath(instance) {
  return join(instanceConfDir(instance.id), FILE_NAME);
}

/**
 * Read the sync_list of an instance.
 * @param {object} instance Instance record.
 * @returns {{exists: boolean, text: string}} Contents, empty when there is none.
 */
export function read(instance) {
  const file = filePath(instance);
  if (!existsSync(file)) return { exists: false, text: "" };
  return { exists: true, text: readFileSync(file, "utf8") };
}

/**
 * Write the sync_list of an instance, or remove it when the text is empty.
 *
 * An empty file is not the same as no file: with an empty sync_list the client
 * would sync nothing at all, while no file means "sync everything". Removing it
 * is therefore the correct interpretation of clearing the editor.
 *
 * @param {object} instance Instance record.
 * @param {string} text Raw editor contents.
 * @returns {{exists: boolean, text: string}} The stored state.
 * @throws {import("./validate.js").ValidationError} On invalid contents.
 */
export function write(instance, text) {
  const normalised = validate.syncListText(text);
  const file = filePath(instance);

  // Only comments and blank lines means there is no active rule, which would
  // select nothing; treat it like clearing the list.
  const hasRule = normalised
    .split("\n")
    .some((line) => line.trim() && !line.trim().startsWith("#"));

  if (!hasRule) {
    rmSync(file, { force: true });
    return { exists: false, text: "" };
  }

  // Atomic: a truncated sync_list is still syntactically valid, it just selects
  // fewer folders, and the resync that follows would remove the local copies of
  // everything that dropped out.
  writeFileAtomic(file, normalised, { mode: 0o600 });
  return { exists: true, text: normalised };
}
