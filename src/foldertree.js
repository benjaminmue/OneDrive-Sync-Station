// The remote folder tree of an account, for the folder selection.
//
// Read from the sync client's own item database rather than from Microsoft
// Graph. That is a deliberate trade:
//
//   - Graph would need the station to redeem the refresh token itself, and
//     Microsoft rotates refresh tokens. A second consumer risks invalidating
//     the sign-in of the running client, which is a high price for a listing.
//   - The local sync directory only shows what is already downloaded, so it is
//     useless for the main case: picking a few folders out of many BEFORE
//     syncing them.
//   - The item database holds every folder the client saw in the /delta
//     response, including ones it never downloads. No token is touched, and the
//     data is exactly as fresh as the client's last sync.
//
// The price is a dependency on a schema this project does not own, so every
// access is defensive: the database is opened read-only, missing tables or
// columns are reported as "not available yet" rather than thrown at the user,
// and the UI keeps the plain rule editor as the way that always works.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { instanceConfDir } from "./config.js";
import { log } from "./logger.js";

/** File the client keeps its item cache in, inside its config directory. */
const DATABASE_FILE = "items.sqlite3";

/** Item types that represent something a sync_list rule can select. */
const FOLDER_TYPES = new Set(["dir", "remote"]);

/** Safety bound: a pathological account must not turn into an endless listing. */
const MAX_FOLDERS = 20_000;

/**
 * @typedef {object} FolderNode
 * @property {string} name Folder name as it appears in OneDrive.
 * @property {string} path Absolute path from the drive root, starting with "/".
 * @property {FolderNode[]} children Subfolders, sorted by name.
 */

/**
 * Absolute path of the item database of an instance.
 * @param {object} instance Instance record.
 * @returns {string} Absolute path.
 */
function databasePath(instance) {
  return join(instanceConfDir(instance.id), DATABASE_FILE);
}

/**
 * Read the folder rows of an account from the client's item database.
 * @param {string} file Absolute path of the database.
 * @returns {Array<{id: string, name: string, parentId: string|null}>} Folder rows.
 */
function readFolderRows(file) {
  // Read-only: the client owns this database and may be writing to it. We never
  // modify it, and opening it read-only makes that impossible by accident.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT id, name, type, parentId FROM item WHERE type IN ('dir', 'remote')")
      .all();
    return rows
      .filter((row) => FOLDER_TYPES.has(row.type))
      .map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ""),
        parentId: row.parentId ? String(row.parentId) : null,
      }));
  } finally {
    db.close();
  }
}

/**
 * Build a nested tree from flat parent-child rows.
 *
 * Rows whose parent is not itself a folder row are treated as top level: that
 * covers the drive root, whose parent is the root item, and any folder whose
 * ancestor the client has not recorded.
 *
 * @param {Array<{id: string, name: string, parentId: string|null}>} rows Folder rows.
 * @returns {FolderNode[]} Root level folders, sorted by name.
 */
export function buildTree(rows) {
  /** @type {Map<string, FolderNode & {id: string, parentId: string|null}>} */
  const byId = new Map();
  for (const row of rows) {
    if (!row.name) continue;
    byId.set(row.id, { ...row, path: "", children: [] });
  }

  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  /**
   * Assign absolute paths and sort each level.
   * @param {Array<FolderNode>} nodes Nodes at one level.
   * @param {string} prefix Path of the parent.
   * @returns {FolderNode[]} The same nodes, sorted, with paths filled in.
   */
  const walk = (nodes, prefix) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const node of nodes) {
      node.path = `${prefix}/${node.name}`;
      walk(node.children, node.path);
    }
    return nodes;
  };

  return walk(roots, "");
}

/**
 * Count the nodes of a tree.
 * @param {FolderNode[]} nodes Tree to count.
 * @returns {number} Total number of folders.
 */
function countNodes(nodes) {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

/**
 * Read the remote folder tree of an account.
 *
 * Never throws for the ordinary reasons it can fail: an account that has not
 * synced yet has no database, and a client mid-write can hold a lock. Both are
 * reported as an unavailable listing with a reason the UI can explain, because
 * the rule editor next to it works regardless.
 *
 * @param {object} instance Instance record.
 * @returns {{available: boolean, reason?: string, folders: FolderNode[], truncated?: boolean}} The tree or why there is none.
 */
export function readFolderTree(instance) {
  const file = databasePath(instance);
  if (!existsSync(file)) {
    return { available: false, reason: "not-synced-yet", folders: [] };
  }

  try {
    const rows = readFolderRows(file);
    const folders = buildTree(rows);
    const total = countNodes(folders);
    return {
      available: true,
      folders,
      truncated: total > MAX_FOLDERS,
    };
  } catch (err) {
    // A locked database is transient, anything else means the schema moved
    // under us. Both leave the user with the rule editor, so neither is fatal.
    const locked = /locked|busy/i.test(err.message || "");
    log.warn("could not read the folder tree", { instance: instance.id, err: err.message });
    return {
      available: false,
      reason: locked ? "database-busy" : "unreadable",
      folders: [],
    };
  }
}
