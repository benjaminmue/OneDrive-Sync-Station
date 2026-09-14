// The folder tree of an account, for the folder selection.
//
// Three kinds of source contribute, and they are merged rather than ranked:
//
//   - The listing of the last discovery run. Normally read from Microsoft
//     Graph (graph.js, which also explains why redeeming the client's refresh
//     token there is safe), it names every folder of the account and is the
//     only source that can say a folder does NOT exist online. After a
//     dry-run fallback it names only the folders missing locally.
//   - The sync client's own item database, which knows what the client last
//     saw. With a selection in force that is only the selected folders, but it
//     does know folders synced after the listing was read.
//   - The data directory, which holds exactly what is already downloaded.
//
// The database is a schema this project does not own, so every access to it is
// defensive: read from a copy, missing tables or columns count as "nothing
// here", and the UI keeps the plain rule editor as the way that always works.

import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERED_FILE } from "./discovery.js";
import { DatabaseSync } from "node:sqlite";
import { instanceConfDir, instanceDataDir } from "./config.js";
import { log } from "./logger.js";

/** File the client keeps its item cache in, inside its config directory. */
const DATABASE_FILE = "items.sqlite3";

/** The cache a dry run of the client may leave; read if it is there. */
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
 * The folder listing the last discovery run stored.
 *
 * `complete` is only true for a listing read from Microsoft Graph, which names
 * every folder of the account. A dry run names just the folders missing
 * locally, and files from before this flag existed are treated the same way.
 * @param {object} instance Instance record.
 * @returns {{paths: string[], complete: boolean, shared: string[]}} Recorded paths, whether they cover
 *   the account, and the folders shared in from other drives, whose contents they do not cover.
 */
function readDiscoveredListing(instance) {
  const none = { paths: [], complete: false, shared: [] };
  const file = join(instanceConfDir(instance.id), DISCOVERED_FILE);
  if (!existsSync(file)) return none;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const strings = (list) => (Array.isArray(list) ? list.filter((p) => typeof p === "string") : []);
    return { paths: strings(data?.folders), complete: data?.complete === true, shared: strings(data?.remote) };
  } catch {
    // A truncated or hand-edited file is not worth failing over; the other
    // sources still apply.
    return none;
  }
}

/**
 * Read the folder rows of an account from the client's item database.
 * @param {string} file Absolute path of the database.
 * @returns {Array<{id: string, name: string, parentId: string|null}>} Folder rows.
 */
function readFolderRows(file) {
  // Read from a copy, not from the live file. The running client holds a lock
  // on its database, and read-only is not enough against it: opening it while
  // the client syncs fails with "database is locked", the folder list then
  // silently falls back to weaker sources, and folders that came from OneDrive
  // minutes ago end up marked as existing only on this server.
  const copy = copyForReading(file);
  if (!copy) return [];

  const db = new DatabaseSync(copy, { readOnly: true });
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
    for (const suffix of ["", "-wal", "-shm"]) rmSync(copy + suffix, { force: true });
  }
}

/**
 * Copy a client database somewhere it can be read without contending for locks.
 *
 * The copy may catch the client mid-write and come out inconsistent. That is
 * acceptable here: a folder listing needs no transactional consistency, and a
 * copy damaged badly enough to fail to open is handled like any other source
 * that has nothing to say.
 *
 * @param {string} file Absolute path of the live database.
 * @returns {string|null} Path of the copy, or null when it is not worth making.
 */
function copyForReading(file) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  if (size > MAX_DB_COPY_BYTES) {
    log.warn("folder cache too large to copy", { file, size });
    return null;
  }

  const copy = `${file}.reading-${process.pid}-${++copyCounter}`;
  try {
    copyFileSync(file, copy);
    // A database in WAL mode keeps recent writes beside the main file; without
    // these the copy reads as an older state, or not at all.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix);
    }
    return copy;
  } catch (err) {
    log.warn("could not copy a folder cache", { file, err: err.message });
    rmSync(copy, { force: true });
    return null;
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

/** Above this a database is not copied; a folder list is not worth the disk. */
const MAX_DB_COPY_BYTES = 512 * 1024 * 1024;

/** Makes each database copy unique within this process. */
let copyCounter = 0;

/** Leading separator, stripped so every source compares in the same shape. */
const LEADING_SLASH = new RegExp("^/");

/**
 * State the flag as unknown, so the interface says nothing rather than
 * something wrong.
 * @param {FolderNode[]} nodes Tree to walk.
 * @returns {void}
 */
function clearLocalOnly(nodes) {
  for (const node of nodes) {
    node.localOnly = false;
    clearLocalOnly(node.children);
  }
}

/**
 * Flag folders that exist locally but are unknown online.
 *
 * Nothing below a shared folder is flagged: its contents live on the owner's
 * drive and are not part of the listing, so absence there proves nothing.
 * @param {FolderNode[]} nodes Tree to walk.
 * @param {Set<string>} remote Paths known from any online source.
 * @param {string[]} shared Shared folders whose contents the listing does not cover.
 * @returns {void}
 */
function markLocalOnly(nodes, remote, shared) {
  for (const node of nodes) {
    const relative = node.path.replace(LEADING_SLASH, "");
    const insideShared = shared.some((folder) => relative.startsWith(`${folder}/`));
    node.localOnly = !insideShared && !remote.has(relative);
    markLocalOnly(node.children, remote, shared);
  }
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
      paths.push(node.path.replace(LEADING_SLASH, ""));
      walk(node.children);
    }
  };
  walk(nodes);
  return paths;
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
    // Every source contributes; see the header of this module for what each
    // one knows. Letting one source win, as this did before, produced a list
    // that shrank as syncing progressed.
    const listing = readDiscoveredListing(instance);
    const remote = mergePaths([
      flattenPaths(safeTreeFrom(databasePath(instance))),
      flattenPaths(safeTreeFrom(dryRunDatabasePath(instance))),
      listing.paths,
    ]);
    const local = flattenPaths(readLocalTree(instance).folders);
    // Local first: past MAX_FOLDERS the list is cut from the end, and the local
    // folders are the ones that may need the "only here" warning.
    const paths = mergePaths([local, remote]);

    if (!paths.length) return { available: false, reason: "not-synced-yet", folders: [] };

    // A folder that exists here but is unknown online was created on this
    // server. If the selection does not cover it, nothing ever uploads it and
    // nothing says so, which is how an unprotected folder goes unnoticed.
    const folders = treeFromPaths(paths.slice(0, MAX_FOLDERS));
    // Only against a listing that names every folder of the account. Anything
    // less makes a synced folder look local as soon as its source leaves it
    // out: a reload after it was downloaded, or a cache emptied by a resync
    // (#4). Saying nothing is better than a warning that is wrong, because it
    // reads as "none of this is backed up anywhere". The other online sources
    // still join in, so a folder synced after the listing was read is known.
    if (listing.complete) markLocalOnly(folders, new Set(remote), listing.shared);
    else clearLocalOnly(folders);

    return {
      available: true,
      source: "combined",
      folders,
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
