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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { instanceConfDir, instanceDataDir } from "./config.js";
import { log } from "./logger.js";

/** File the client keeps its item cache in, inside its config directory. */
const DATABASE_FILE = "items.sqlite3";

/**
 * The cache a dry run writes instead. It is what makes choosing folders before
 * the first sync possible at all: a discovery run fills this one while
 * transferring nothing.
 */
const DRY_RUN_DATABASE_FILE = "items-dryrun.sqlite3";

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
 * Absolute path of the dry-run item database of an instance.
 * @param {object} instance Instance record.
 * @returns {string} Absolute path.
 */
function dryRunDatabasePath(instance) {
  return join(instanceConfDir(instance.id), DRY_RUN_DATABASE_FILE);
}

/**
 * Try one database file and return its folder tree, or null.
 * @param {string} file Absolute path of a candidate database.
 * @param {string} source Label reported to the caller.
 * @returns {{available: true, source: string, folders: FolderNode[], truncated: boolean}|null} The tree, or null when this source has nothing.
 */
/**
 * Folder tree from one database, or an empty list when it cannot be read.
 *
 * A missing or damaged cache is one source being unavailable, not a failure:
 * the others still contribute.
 *
 * @param {string} file Absolute path of a candidate database.
 * @returns {FolderNode[]} Folders, empty when this source has none.
 */
function safeTreeFrom(file) {
  if (!existsSync(file)) return [];
  try {
    return buildTree(readFolderRows(file));
  } catch (err) {
    log.warn("could not read a folder cache", { file, err: err.message });
    return [];
  }
}

/**
 * Folder paths a discovery run recorded, or an empty list.
 * @param {object} instance Instance record.
 * @returns {string[]} Recorded paths.
 */
function readDiscoveredPaths(instance) {
  const file = join(instanceConfDir(instance.id), "discovered-folders.json");
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data?.folders) ? data.folders : [];
  } catch {
    return [];
  }
}

function treeFrom(file, source) {
  if (!existsSync(file)) return null;
  const folders = buildTree(readFolderRows(file));
  if (!folders.length) return null;
  return { available: true, source, folders, truncated: countNodes(folders) > MAX_FOLDERS };
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
 * Build a tree from flat paths such as "Bilder/Paps".
 *
 * Intermediate folders are created as needed: the client names a nested folder
 * even when it never mentions its parent on a line of its own.
 *
 * @param {string[]} paths Folder paths relative to the account root.
 * @returns {FolderNode[]} Root level folders, sorted by name.
 */
export function treeFromPaths(paths) {
  const roots = [];
  const byPath = new Map();

  for (const raw of [...paths].sort()) {
    const parts = raw.split("/").filter(Boolean);
    let prefix = "";
    let siblings = roots;
    for (const name of parts) {
      const path = `${prefix}/${name}`;
      let node = byPath.get(path);
      if (!node) {
        node = { name, path, children: [] };
        byPath.set(path, node);
        siblings.push(node);
      }
      siblings = node.children;
      prefix = path;
    }
  }

  /**
   * Sort every level by name.
   * @param {FolderNode[]} nodes Nodes to sort.
   * @returns {FolderNode[]} The same nodes, sorted.
   */
  const sort = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((node) => sort(node.children));
    return nodes;
  };
  return sort(roots);
}

/**
 * Merge several sets of folder paths into one tree.
 *
 * The sources have to add up rather than take turns. A discovery run only names
 * directories that do not exist locally yet, so on an account that is already
 * partly synced it reports the missing ones and stays silent about the rest;
 * used alone it would show a list that shrinks as syncing progresses, and an
 * empty one for an account that is fully synced.
 *
 * @param {string[][]} sets Path lists to combine.
 * @returns {string[]} Every path, without duplicates.
 */
function mergePaths(sets) {
  const all = new Set();
  for (const set of sets) for (const path of set) if (path) all.add(path);
  return [...all];
}

/**
 * Flatten a tree back to its paths, relative and without the leading slash.
 * @param {FolderNode[]} nodes Tree to flatten.
 * @returns {string[]} Paths.
 */
function flattenPaths(nodes) {
  const paths = [];
  const walk = (list) => {
    for (const node of list) {
      paths.push(node.path.replace(new RegExp("^\\/"), ""));
      walk(node.children);
    }
  };
  walk(nodes);
  return paths;
}

/**
 * Read the folders a discovery run recorded.
 *
 * The run writes them out because they exist nowhere else afterwards: the
 * client keeps its dry-run state in a database it does not leave behind, so the
 * only record of what it found is the output it printed while walking the
 * account.
 *
 * @param {object} instance Instance record.
 * @returns {{available: true, source: string, folders: FolderNode[], truncated: boolean}|null} The tree, or null when there was no run.
 */
function readDiscovered(instance) {
  const file = join(instanceConfDir(instance.id), "discovered-folders.json");
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(data?.folders) || !data.folders.length) return null;
    return {
      available: true,
      source: "discovery",
      folders: treeFromPaths(data.folders.slice(0, MAX_FOLDERS)),
      truncated: data.folders.length > MAX_FOLDERS,
    };
  } catch {
    // A truncated or hand-edited file is not worth failing over; the other
    // sources still apply.
    return null;
  }
}

/** How deep the local fallback descends. Deeper folders are still selectable by hand. */
const LOCAL_MAX_DEPTH = 6;

/**
 * Build the folder tree from the directories that exist on disk.
 *
 * The fallback for when the item cache has nothing to offer: right after a
 * resync, for an account whose client never finished a run, or if the client's
 * schema ever moves. It can only show what is already synced, which is useless
 * for picking folders before the first sync but exactly right afterwards, when
 * the question is which of the existing folders to keep.
 *
 * @param {string} root Absolute path of the account's data directory.
 * @param {number} depth Remaining depth to descend.
 * @param {string} prefix Path prefix for the nodes at this level.
 * @param {{count: number}} budget Shared node budget, so a huge tree cannot run away.
 * @returns {FolderNode[]} Folders at this level, sorted by name.
 */
function readLocalLevel(root, depth, prefix, budget) {
  if (depth <= 0 || budget.count >= MAX_FOLDERS) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Hidden directories are the client's own bookkeeping and other tools'
    // metadata; nobody selects those on purpose.
    if (entry.name.startsWith(".")) continue;
    if (budget.count >= MAX_FOLDERS) break;
    budget.count += 1;
    const path = `${prefix}/${entry.name}`;
    nodes.push({
      name: entry.name,
      path,
      children: readLocalLevel(join(root, entry.name), depth - 1, path, budget),
    });
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name));
  return nodes;
}

/**
 * Read the folder tree from the local data directory of an account.
 * @param {object} instance Instance record.
 * @returns {{available: boolean, reason?: string, folders: FolderNode[], source?: string, truncated?: boolean}} The tree or why there is none.
 */
function readLocalTree(instance) {
  const root = instanceDataDir(instance.folder);
  if (!existsSync(root)) return { available: false, reason: "not-synced-yet", folders: [] };

  const budget = { count: 0 };
  const folders = readLocalLevel(root, LOCAL_MAX_DEPTH, "", budget);
  if (!folders.length) return { available: false, reason: "not-synced-yet", folders: [] };
  return {
    available: true,
    source: "local-files",
    folders,
    truncated: budget.count >= MAX_FOLDERS,
  };
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
  try {
    // Every source contributes; none of them is complete on its own.
    //
    //   - the sync cache knows what the client last saw, but with a folder
    //     selection in force that is only the selected folders
    //   - a discovery run names directories that are missing locally, so it
    //     says nothing about the ones already synced
    //   - the data directory holds exactly the ones already synced
    //
    // Together they cover the account. Letting one source win, as this did
    // before, produced a list that shrank as syncing progressed.
    const paths = mergePaths([
      flattenPaths(safeTreeFrom(databasePath(instance))),
      flattenPaths(safeTreeFrom(dryRunDatabasePath(instance))),
      readDiscoveredPaths(instance),
      flattenPaths(readLocalTree(instance).folders),
    ]);

    if (!paths.length) return { available: false, reason: "not-synced-yet", folders: [] };
    return {
      available: true,
      source: "combined",
      folders: treeFromPaths(paths.slice(0, MAX_FOLDERS)),
      truncated: paths.length > MAX_FOLDERS,
    };
  } catch (err) {
    // A locked database is transient, anything else means the schema moved
    // under us. Both leave the user with the rule editor, so neither is fatal.
    log.warn("could not read the folder tree", { instance: instance.id, err: err.message });
    // Whatever went wrong with the cache, the directories on disk are still
    // there, and a partial list beats an empty panel.
    const local = readLocalTree(instance);
    if (local.available) return local;
    const locked = /locked|busy/i.test(err.message || "");
    return {
      available: false,
      reason: locked ? "database-busy" : "unreadable",
      folders: [],
    };
  }
}
