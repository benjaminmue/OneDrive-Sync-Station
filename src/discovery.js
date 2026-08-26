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
import { baseArgs, clientCommand } from "./onedrive.js";
import { appendLog } from "./supervisor.js";
import { log } from "./logger.js";

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

  // --dry-run makes the client report instead of transfer, and it keeps its
  // findings in a separate database, so nothing about the real sync state
  // changes. --resync is required alongside it here because the configuration
  // has just been written, and the client refuses to start otherwise.
  const args = [...baseArgs(instance), "--sync", "--dry-run", "--resync", "--resync-auth", "--verbose"];
  const invocation = clientCommand(args);
  const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "pipe", "pipe"] });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => appendLog(instance.id, chunk));
  child.stderr.on("data", (chunk) => appendLog(instance.id, chunk));

  const finish = (ok) => {
    const run = running.get(instance.id);
    if (!run || run.child !== child) return;
    clearTimeout(run.timeout);
    running.delete(instance.id);
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
