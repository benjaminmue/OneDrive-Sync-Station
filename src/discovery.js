// Discovering the folders of an account without downloading anything.
//
// This exists because of an ordering problem that is easy to get wrong: to
// choose folders you need to see them, and to see them the client has to talk
// to Microsoft, but the moment it does that in a normal run it starts pulling
// files. On an account with twelve thousand files that means gigabytes arrive
// before the user has had a chance to say what they wanted.
//
// A dry run resolves it. The client fetches the full /delta response, records
// what it found, reports what it would do, and transfers nothing. It even keeps
// that state in a separate database (items-dryrun.sqlite3), so the real sync
// state is untouched.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { existsSync, renameSync, rmSync } from "node:fs";
import { baseArgs, clientCommand } from "./onedrive.js";
import { instanceConfDir } from "./config.js";
import { writeFileAtomic } from "./storage.js";
import { appendLog } from "./supervisor.js";
import { log } from "./logger.js";

/** Where a completed run leaves the folders it found. */
export const DISCOVERED_FILE = "discovered-folders.json";

/**
 * The folder selection is moved aside for the duration of a run.
 *
 * Without this the run sees only what the selection already includes, which is
 * useless: the whole point of listing the folders is to show the ones that are
 * NOT selected yet, so they can be added. The file is restored when the run
 * ends, and a leftover from a crash is restored on the next attempt.
 */
const SELECTION_FILE = "sync_list";
const SELECTION_PARKED = "sync_list.discovery-backup";

/**
 * Move the folder selection out of the client's way, if there is one.
 * @param {string} confDir Config directory of the instance.
 * @returns {boolean} True when a selection was parked and must be restored.
 */
function parkSelection(confDir) {
  const active = join(confDir, SELECTION_FILE);
  const parked = join(confDir, SELECTION_PARKED);
  // A leftover from an interrupted run wins: it is the real selection.
  if (existsSync(parked) && !existsSync(active)) {
    renameSync(parked, active);
  }
  if (!existsSync(active)) return false;
  rmSync(parked, { force: true });
  renameSync(active, parked);
  return true;
}

/**
 * Put the folder selection back.
 * @param {string} confDir Config directory of the instance.
 * @returns {void}
 */
function restoreSelection(confDir) {
  const active = join(confDir, SELECTION_FILE);
  const parked = join(confDir, SELECTION_PARKED);
  if (!existsSync(parked)) return;
  rmSync(active, { force: true });
  renameSync(parked, active);
}

/**
 * Folder paths the client mentions while walking the account.
 *
 * A dry run names every directory it would create, with its full path. That is
 * the only reliable source for this listing: the client keeps its dry-run state
 * in a database it does not leave behind, so there is nothing to read once the
 * run has finished.
 */
const FOLDER_LINE = new RegExp(
  "Attempting to create local directory:\\s*\\.?/?(.+?)\\s*$",
  "gm"
);

/**
 * Extract folder paths from a chunk of client output.
 * @param {string} chunk Raw client output.
 * @returns {string[]} Folder paths relative to the account root.
 */
export function parseFolderLines(chunk) {
  const found = [];
  for (const match of String(chunk).matchAll(FOLDER_LINE)) {
    const path = match[1].trim();
    // "." is the account root itself, not something to offer for selection.
    if (path && path !== "." && path !== "./") found.push(path.replace(new RegExp("^\\./"), ""));
  }
  return found;
}

/** Emits `discovery` events so the API can tell the browser when a run ends. */
export const events = new EventEmitter();
events.setMaxListeners(100);

/** A discovery run on a large account takes minutes, not seconds. */
const DISCOVERY_TIMEOUT_MS = 30 * 60_000;

/**
 * @typedef {object} DiscoveryRun
 * @property {import("node:child_process").ChildProcess} child The running client.
 * @property {number} startedAt Epoch ms when it began.
 * @property {NodeJS.Timeout} timeout Gives up on a run that never ends.
 */

/** @type {Map<string, DiscoveryRun>} */
const running = new Map();

/**
 * Whether a discovery run is in progress for an instance.
 * @param {string} id Instance id.
 * @returns {boolean} True while a run is active.
 */
export function isRunning(id) {
  return running.has(id);
}

/**
 * State of the discovery run of an instance.
 * @param {string} id Instance id.
 * @returns {{running: boolean, startedAt: number}} Current state.
 */
export function status(id) {
  const run = running.get(id);
  return { running: Boolean(run), startedAt: run?.startedAt ?? 0 };
}

/**
 * Start a discovery run.
 *
 * The caller must ensure no sync client of this instance is running: both would
 * hold the same config directory. Idempotent, so a second click does not spawn
 * a second run.
 *
 * @param {object} instance Instance record.
 * @returns {{started: boolean}} Whether this call started a run.
 */
export function start(instance) {
  if (running.has(instance.id)) return { started: false };

  // Run without the folder selection, otherwise the listing shows only what is
  // already selected and the folders the user might want to add stay invisible.
  const confDir = instanceConfDir(instance.id);
  const parkedSelection = parkSelection(confDir);

  // --dry-run makes the client report instead of transfer, and it keeps its
  // findings in a separate database, so nothing about the real sync state
  // changes. --resync is required alongside it here because the configuration
  // has just been written, and the client refuses to start otherwise.
  const args = [...baseArgs(instance), "--sync", "--dry-run", "--resync", "--resync-auth", "--verbose"];
  const invocation = clientCommand(args);
  const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "pipe", "pipe"] });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // Collected as the run goes: the folders are only ever visible in this
  // output, so they have to be picked up while it streams past.
  const folders = new Set();
  const collect = (chunk) => {
    appendLog(instance.id, chunk);
    for (const path of parseFolderLines(chunk)) folders.add(path);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const finish = (ok) => {
    const run = running.get(instance.id);
    if (!run || run.child !== child) return;
    clearTimeout(run.timeout);
    running.delete(instance.id);
    if (parkedSelection) restoreSelection(confDir);

    // Written even on a partial run: half a listing is still better than none,
    // and the user can start the discovery again.
    if (folders.size) {
      try {
        writeFileAtomic(
          join(instanceConfDir(instance.id), DISCOVERED_FILE),
          JSON.stringify({ at: new Date().toISOString(), folders: [...folders] }, null, 2),
          { mode: 0o600 }
        );
      } catch (err) {
        log.warn("could not store the discovered folders", {
          instance: instance.id,
          err: err.message,
        });
      }
    }

    appendLog(
      instance.id,
      ok
        ? "[station] folder discovery finished, the list is ready"
        : "[station] folder discovery did not complete, see the lines above"
    );
    log.info("discovery finished", { instance: instance.id, ok });
    events.emit("discovery", { id: instance.id, running: false, ok });
  };

  child.on("error", (err) => {
    appendLog(instance.id, `[station] could not start folder discovery: ${err.message}`);
    finish(false);
  });
  child.on("close", (code) => finish(code === 0));

  const timeout = setTimeout(() => {
    appendLog(instance.id, "[station] folder discovery took too long and was stopped");
    child.kill("SIGINT");
  }, DISCOVERY_TIMEOUT_MS);

  running.set(instance.id, { child, startedAt: Date.now(), timeout });
  appendLog(instance.id, "[station] looking at the account without downloading anything");
  log.info("discovery started", { instance: instance.id });
  events.emit("discovery", { id: instance.id, running: true });
  return { started: true };
}

/**
 * Stop a discovery run.
 * @param {string} id Instance id.
 * @returns {void}
 */
export function stop(id) {
  const run = running.get(id);
  if (!run) return;
  run.child.kill("SIGINT");
}

/**
 * Stop every discovery run, for shutdown.
 * @returns {void}
 */
export function stopAll() {
  for (const id of running.keys()) stop(id);
}
