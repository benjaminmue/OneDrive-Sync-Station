// Repair of the file modes older versions left in an account's data folder.
//
// Up to v0.6.0 the client set every download to 0600 and every folder to 0700,
// overriding the container's UMASK, so an SMB share could not open the files.
// The client config now leaves modes to the umask, which only helps new files.
// This walk brings existing ones to the modes the umask produces.
//
// It is deliberately a button and not a start-up migration: exactly 0600 and
// 0700 are the client's fingerprint, but an operator can have chosen them too,
// and widening a private file on an update nobody asked for is not acceptable.
//
// The data folder is writable by whoever can write to the share, so anything in
// it can be swapped for a symlink while the walk runs, the account folder
// itself included. A path checked and then chmodded by name could therefore
// widen a file outside the account, up to the refresh tokens in /config. Every
// change goes through a descriptor instead: opened without following a final
// symlink, verified to lie inside the account folder, then inspected and
// changed through that same descriptor. Only DATA_DIR, set by the operator, is
// trusted as a path.

import { constants, existsSync } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { DATA_DIR } from "./config.js";
import { log } from "./logger.js";

const CLIENT_FILE_MODE = 0o600;
const CLIENT_DIR_MODE = 0o700;

// O_NONBLOCK: an entry swapped for a FIFO must not hang the walk on open.
const OPEN_FILE = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const OPEN_DIR = OPEN_FILE | (constants.O_DIRECTORY ?? 0);

// Linux exposes each open descriptor as a link to the object it refers to.
// Opening a name below such a link resolves it against that exact directory,
// which is what openat does, so a parent swapped after it was opened is not
// followed. Elsewhere (development machines only) names are resolved by path.
const PROC_FD = "/proc/self/fd";
const viaProc = existsSync(PROC_FD);

/** Instance ids with a repair in progress, so a double click walks once. */
const running = new Set();

/**
 * Format a mode the way the UI and the documentation write it, e.g. "0664".
 * @param {number} mode Permission bits.
 * @returns {string} Four-digit octal.
 */
const octal = (mode) => mode.toString(8).padStart(4, "0");

/**
 * Where an open descriptor really points.
 * @param {import("node:fs/promises").FileHandle} handle Open descriptor.
 * @param {string} path The name it was opened by.
 * @returns {Promise<string>} Absolute real path.
 */
function locate(handle, path) {
  return viaProc ? readlink(`${PROC_FD}/${handle.fd}`) : realpath(path);
}

/**
 * Open a name below the account folder without following a final symlink,
 * and keep the descriptor only if the object is a true descendant of it.
 * @param {string} path Name to open.
 * @param {boolean} isDir Whether a directory is expected.
 * @param {string} rootReal Real path of the account folder.
 * @returns {Promise<import("node:fs/promises").FileHandle|null>} The handle, or null when refused.
 */
export async function openInside(path, isDir, rootReal) {
  let handle;
  try {
    handle = await open(path, isDir ? OPEN_DIR : OPEN_FILE);
    if ((await locate(handle, path)).startsWith(rootReal + sep)) return handle;
  } catch {
    // Swapped, removed or unreadable meanwhile.
  }
  await handle?.close();
  return null;
}

/**
 * Open an account folder below DATA_DIR without following a symlink at its
 * name, and confirm the descriptor is exactly that folder.
 *
 * Resolving the folder path first and opening the result would let a symlink
 * put in its place move the whole walk, say to /config.
 * @param {string} folder Validated folder name.
 * @returns {Promise<{status: "ok"|"missing"|"refused", handle?: import("node:fs/promises").FileHandle, real?: string}>}
 *   "missing" when there is no folder yet, "refused" when it cannot be trusted
 *   or opened.
 */
async function openAccountFolder(folder) {
  let dataHandle;
  try {
    const dataReal = await realpath(DATA_DIR);
    dataHandle = await open(dataReal, OPEN_DIR);
    const expected = join(dataReal, folder);
    const path = viaProc ? `${PROC_FD}/${dataHandle.fd}/${folder}` : expected;
    let handle;
    try {
      handle = await open(path, OPEN_DIR);
      if ((await locate(handle, path)) === expected) return { status: "ok", handle, real: expected };
    } catch (err) {
      // A symlink in the folder's place fails with ELOOP, or ENOTDIR on some
      // systems; only a folder that does not exist yet is not a failure.
      if (err.code === "ENOENT") return { status: "missing" };
    }
    await handle?.close();
    return { status: "refused" };
  } catch {
    return { status: "refused" };
  } finally {
    await dataHandle?.close();
  }
}

/**
 * Change client-created 0600 files and 0700 folders in an instance's data
 * folder to the umask modes. Only entries owned by this process are touched,
 * which are the only ones it may chmod anyway. Symbolic links are never
 * followed and files with more than one hard link are left alone, so the walk
 * cannot change anything outside the folder.
 * @param {object} instance Instance record.
 * @returns {Promise<{files: number, folders: number, failed: number, fileMode: string, folderMode: string}>} What changed.
 * @throws {Error} With statusCode 409 when a repair of this instance is already running.
 */
export async function repairDataModes(instance) {
  if (running.has(instance.id)) {
    throw Object.assign(new Error("repair-running"), { statusCode: 409 });
  }
  running.add(instance.id);
  try {
    // process.umask() without an argument is deprecated in the documentation
    // only: it sets the mask to read it and restores it synchronously.
    const mask = process.umask();
    const target = { file: 0o666 & ~mask, dir: 0o777 & ~mask };
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const result = { files: 0, folders: 0, failed: 0 };
    // A share user can move a finished subtree into one not yet listed, which
    // would make the walk go round in circles for as long as they keep at it.
    const visited = new Set();

    /**
     * Change an open entry if it carries the client's mode.
     * @param {import("node:fs/promises").FileHandle} handle Open descriptor.
     * @param {boolean} isDir Whether a directory is expected.
     * @returns {Promise<void>}
     */
    const repair = async (handle, isDir) => {
      const stats = await handle.stat();
      if (uid !== null && stats.uid !== uid) return;
      const expectedKind = isDir ? stats.isDirectory() : stats.isFile() && stats.nlink === 1;
      if (!expectedKind) return;
      const mode = stats.mode & 0o777;
      if (mode !== (isDir ? CLIENT_DIR_MODE : CLIENT_FILE_MODE)) return;
      const next = isDir ? target.dir : target.file;
      if (next === mode) return;
      await handle.chmod(next);
      if (isDir) result.folders += 1;
      else result.files += 1;
    };

    /**
     * Walk an open directory depth-first, changing it after its contents.
     * @param {import("node:fs/promises").FileHandle} dirHandle Open, verified directory.
     * @param {string} path The name it was opened by.
     * @param {string} rootReal Real path of the account folder.
     * @returns {Promise<void>}
     */
    const walk = async (dirHandle, path, rootReal) => {
      const base = viaProc ? `${PROC_FD}/${dirHandle.fd}` : path;
      // Listing errors (a directory deleted by a sync mid-read) and a failed
      // change of the directory itself both land in the catch below.
      try {
        const { dev, ino } = await dirHandle.stat();
        if (visited.has(`${dev}:${ino}`)) return;
        visited.add(`${dev}:${ino}`);

        for await (const entry of await opendir(base)) {
          if (!entry.isFile() && !entry.isDirectory()) continue;
          const child = join(base, entry.name);
          if (entry.isFile()) {
            // Cheap pre-filter by name. Opening every file would read-open the
            // whole share and count unrelated unreadable files as failures;
            // the decision itself is made on the descriptor.
            const stats = await lstat(child).catch(() => null);
            if (!stats?.isFile() || (stats.mode & 0o777) !== CLIENT_FILE_MODE) continue;
          }
          const handle = await openInside(child, entry.isDirectory(), rootReal);
          if (!handle) {
            result.failed += 1;
            continue;
          }
          try {
            if (entry.isDirectory()) await walk(handle, child, rootReal);
            else await repair(handle, false);
          } catch {
            result.failed += 1;
          } finally {
            await handle.close();
          }
        }
        await repair(dirHandle, true);
      } catch {
        result.failed += 1;
      }
    };

    const root = await openAccountFolder(instance.folder);
    if (root.status === "ok") {
      try {
        await walk(root.handle, root.real, root.real);
      } finally {
        await root.handle.close();
      }
    } else if (root.status === "refused") {
      result.failed += 1;
    }

    const summary = { ...result, fileMode: octal(target.file), folderMode: octal(target.dir) };
    log.info("repaired data folder modes", { instance: instance.id, ...summary });
    return summary;
  } finally {
    running.delete(instance.id);
  }
}
