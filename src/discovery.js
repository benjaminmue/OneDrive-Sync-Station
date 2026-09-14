// Discovering the folders of an account without downloading anything.
//
// This exists because of an ordering problem that is easy to get wrong: to
// choose folders you need to see them, and to see them the client has to talk
// to Microsoft, but the moment it does that in a normal run it starts pulling
// files. On an account with twelve thousand files that means gigabytes arrive
// before the user has had a chance to say what they wanted.
//
// The folder tree is read from Microsoft Graph first (graph.js): a few page
// requests, no download, and a running sync client is left alone. Only when
// that fails does it fall back to a dry run of the client, which fetches the
// same /delta response, reports what it would do and transfers nothing, but
// walks every file on the way and takes minutes on a large account.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { baseArgs, clientCommand } from "./onedrive.js";
import { instanceConfDir } from "./config.js";
import { writeFileAtomic } from "./storage.js";
import { appendLog, hold, release } from "./supervisor.js";
import { getInstance } from "./instances.js";
import { log } from "./logger.js";
import * as graph from "./graph.js";

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
 * Where a write to the folder selection has to land right now.
 *
 * While a run has the selection parked, the active file belongs to the run and
 * is deleted when it restores. A save going there would be silently lost, so it
 * goes to the parked copy instead and takes effect when the run ends.
 *
 * @param {object} instance Instance record.
 * @returns {string} Absolute path to write the selection to.
 */
export function selectionWritePath(instance) {
  // Decided by the run, not by the file: a parked copy left behind by a crash
  // must not swallow saves while a Graph run, which never parks, is going.
  const parkedByRun = running.get(instance.id)?.parked === true;
  return join(instanceConfDir(instance.id), parkedByRun ? SELECTION_PARKED : SELECTION_FILE);
}

/**
 * Put back a selection that an interrupted run left parked.
 *
 * A dry run moves the selection aside and restores it at the end. If the
 * station stops in between, the account is left without a selection, which to
 * the client means the whole account. Called at start-up and before every run.
 * @param {object} instance Instance record.
 * @returns {void}
 */
export function recoverSelection(instance) {
  if (running.get(instance.id)?.parked) return;
  const confDir = instanceConfDir(instance.id);
  const active = join(confDir, SELECTION_FILE);
  const parked = join(confDir, SELECTION_PARKED);
  if (!existsSync(parked)) return;
  // A leftover wins only over a missing selection. If both exist, the active
  // one was saved after the interruption and is the newer choice.
  if (existsSync(active)) rmSync(parked, { force: true });
  else renameSync(parked, active);
}

/**
 * Move the folder selection out of the client's way, if there is one.
 * @param {string} confDir Config directory of the instance.
 * @returns {boolean} True when a selection was parked and must be restored.
 */
function parkSelection(confDir) {
  const active = join(confDir, SELECTION_FILE);
  const parked = join(confDir, SELECTION_PARKED);
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

/** A dry run on a large account takes minutes, not seconds. */
const DRY_RUN_TIMEOUT_MS = 30 * 60_000;

/**
 * @typedef {object} DiscoveryRun
 * @property {number} startedAt Epoch ms when it began.
 * @property {boolean} cancelled Set by stop(), so a cancelled run does not fall back.
 * @property {boolean} parked Whether the dry run currently holds the selection.
 * @property {boolean} dryRun Whether the run has moved on to the dry run, which needs the config directory to itself.
 * @property {() => void} cancel Aborts whatever the run is doing at the moment.
 * @property {Promise<void>} ended Resolves when the run has finished.
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
 * Whether a discovery run needs the account's config directory to itself, so
 * the sync client must not be started. True only during the dry-run fallback;
 * reading from Graph leaves the client free to run.
 * @param {string} id Instance id.
 * @returns {boolean} True while the client has to stay stopped.
 */
export function holdsClient(id) {
  return running.get(id)?.dryRun === true;
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
 * Store a folder listing for the folder tree.
 *
 * `complete` says whether the listing names every folder of the account. Only
 * a complete one may be used to call a folder "only here": a dry run names
 * just the folders missing locally, so a synced folder would look local (#4).
 * `remote` lists the folders shared in from other drives, whose contents a
 * complete listing still does not include.
 *
 * A dry run after a failed Graph run does not throw away a complete listing: its
 * folders are added to it, which can only make fewer folders look local.
 * @param {object} instance Instance record.
 * @param {{folders: string[], complete: boolean, remote?: string[]}} listing What was found.
 * @returns {boolean} Whether the listing was stored.
 */
function storeListing(instance, listing) {
  const file = join(instanceConfDir(instance.id), DISCOVERED_FILE);
  let stored = { complete: listing.complete, folders: listing.folders, remote: listing.remote ?? [] };
  if (!listing.complete) {
    try {
      const previous = JSON.parse(readFileSync(file, "utf8"));
      if (previous?.complete === true && Array.isArray(previous.folders)) {
        stored = {
          complete: true,
          folders: [...new Set([...previous.folders, ...listing.folders])],
          remote: Array.isArray(previous.remote) ? previous.remote : [],
        };
      }
    } catch {
      // No previous listing, or an unreadable one: store this one as it is.
    }
  }
  try {
    writeFileAtomic(file, JSON.stringify({ at: new Date().toISOString(), ...stored }, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    log.warn("could not store the discovered folders", { instance: instance.id, err: err.message });
    return false;
  }
}

/**
 * List the folders with the sync client's dry run, the slow fallback.
 *
 * No sync client of this instance may run meanwhile: both would hold the same
 * config directory.
 * @param {object} instance Instance record.
 * @param {DiscoveryRun} run The run this belongs to.
 * @returns {Promise<boolean>} Whether the client finished cleanly.
 */
function dryRun(instance, run) {
  return new Promise((resolve) => {
    // Run without the folder selection, otherwise the listing shows only what
    // is already selected and the folders the user might want to add stay
    // invisible.
    const confDir = instanceConfDir(instance.id);
    run.parked = parkSelection(confDir);
    const parkedSelection = run.parked;

    // --dry-run makes the client report instead of transfer, and it keeps its
    // findings in a separate database, so nothing about the real sync state
    // changes. --resync is required alongside it here because the configuration
    // has just been written, and the client refuses to start otherwise.
    const args = [...baseArgs(instance), "--sync", "--dry-run", "--resync", "--resync-auth", "--verbose"];
    const invocation = clientCommand(args);
    const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "pipe", "pipe"] });
    run.cancel = () => child.kill("SIGINT");

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

    const timeout = setTimeout(() => {
      appendLog(instance.id, "[station] folder discovery took too long and was stopped");
      child.kill("SIGINT");
    }, DRY_RUN_TIMEOUT_MS);

    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (parkedSelection) restoreSelection(confDir);
      run.parked = false;
      // Written even on a partial run: half a listing is still better than
      // none, and the user can start the discovery again.
      const stored = folders.size ? storeListing(instance, { folders: [...folders], complete: false }) : true;
      resolve(ok && stored);
    };
    child.on("error", (err) => {
      appendLog(instance.id, `[station] could not start folder discovery: ${err.message}`);
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * Read the folder list, from Graph if possible and from a dry run otherwise.
 * @param {object} instance Instance record.
 * @param {DiscoveryRun} run The run this belongs to.
 * @returns {Promise<boolean>} Whether a listing was produced cleanly.
 */
async function discover(instance, run) {
  recoverSelection(instance);
  const controller = new AbortController();
  run.cancel = () => controller.abort();
  const began = Date.now();
  try {
    const result = await graph.listFolders(instance, { signal: controller.signal });
    const stored = storeListing(instance, { folders: result.folders, complete: true, remote: result.remote });
    const seconds = ((Date.now() - began) / 1000).toFixed(1);
    appendLog(
      instance.id,
      `[station] read ${result.folders.length} folders from Microsoft Graph in ${seconds} s`
    );
    log.info("folder list read from graph", {
      instance: instance.id,
      folders: result.folders.length,
      items: result.items,
      pages: result.pages,
      ms: Date.now() - began,
    });
    return stored;
  } catch (err) {
    if (run.cancelled) return false;
    const reason = err instanceof graph.GraphError ? err.message : "error";
    appendLog(
      instance.id,
      `[station] Microsoft Graph could not list the folders (${reason}), using a dry run of the sync client instead, which takes longer`
    );
    log.warn("graph folder listing failed, falling back to a dry run", {
      instance: instance.id,
      reason: err.message,
    });
  }

  // Only the fallback needs the client stopped. The flag goes up first, so the
  // API refuses a Start from this moment, and the supervisor's hold keeps every
  // other way of starting the client (restart timers, a restart after saving
  // the selection) from bringing it back before release.
  run.dryRun = true;
  await hold(instance.id);
  try {
    if (run.cancelled) return false;
    return await dryRun(instance, run);
  } finally {
    // With --resync: the dry run moved the selection aside and put it back,
    // which the client counts as two configuration changes and answers with
    // EXIT_RESYNC_REQUIRED. Nothing starts unless the account is meant to run,
    // so a Stop in the meantime, or a shutdown, is respected.
    release(instance.id, { instance: getInstance(instance.id), resync: true });
  }
}

/**
 * Start a discovery run.
 *
 * Idempotent, so a second click does not start a second run. The run reads the
 * folder tree from Microsoft Graph, which leaves a running sync client alone.
 * Only if that fails does it fall back to a dry run of the client, holding the
 * client stopped for as long as that takes and resuming it afterwards.
 *
 * @param {object} instance Instance record.
 * @returns {{started: boolean}} Whether this call started a run.
 */
export function start(instance) {
  if (running.has(instance.id)) return { started: false };

  let ended;
  /** @type {DiscoveryRun} */
  const run = {
    startedAt: Date.now(),
    cancelled: false,
    parked: false,
    dryRun: false,
    cancel: () => {},
    ended: new Promise((resolve) => (ended = resolve)),
  };
  running.set(instance.id, run);
  appendLog(instance.id, "[station] reading the folder list, nothing is downloaded");
  log.info("discovery started", { instance: instance.id });
  events.emit("discovery", { id: instance.id, running: true });

  const finish = (ok) => {
    if (running.get(instance.id) !== run) return;
    running.delete(instance.id);
    appendLog(
      instance.id,
      ok
        ? "[station] folder discovery finished, the list is ready"
        : "[station] folder discovery did not complete, see the lines above"
    );
    log.info("discovery finished", { instance: instance.id, ok });
    events.emit("discovery", { id: instance.id, running: false, ok });
    ended();
  };
  discover(instance, run).then(finish, (err) => {
    log.error("discovery failed", { instance: instance.id, err: err.message });
    finish(false);
  });
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
  run.cancelled = true;
  run.cancel();
}

/**
 * Stop every discovery run, for shutdown.
 * @returns {Promise<void>} Resolves when every run has ended.
 */
export function stopAll() {
  const ending = [...running.values()].map((run) => run.ended);
  for (const id of running.keys()) stop(id);
  // Awaited on shutdown: a dry run puts the selection back when it ends, and
  // exiting before that leaves the account without one.
  return Promise.all(ending).then(() => {});
}
