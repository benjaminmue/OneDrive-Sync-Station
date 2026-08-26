// Process supervision for the running sync clients.
//
// One child process per instance, started with --monitor so the client keeps
// syncing on its own. The supervisor owns the lifecycle: start, stop, restart,
// automatic restart after an unexpected exit, and the log tail the UI reads.
//
// A single container running N clients is intentional: the alternative, one
// container per account, would mean handing this container the Docker socket,
// which is a far larger privilege than running N child processes.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRingBuffer } from "./ringbuffer.js";
import { baseArgs, clientCommand } from "./onedrive.js";
import { log } from "./logger.js";

/** Emits `log` and `state` events so the API can stream them to the browser. */
export const events = new EventEmitter();

/** An exit within this window after start counts as a failed start. */
const STARTUP_GRACE_MS = 20_000;

/** Backoff bounds for automatic restarts after a failed start. */
const RESTART_BASE_MS = 5_000;
const RESTART_MAX_MS = 300_000;

/** How long a stopping client may take to exit before it is killed. */
const STOP_GRACE_MS = 15_000;

/**
 * @typedef {object} RunnerState
 * @property {import("node:child_process").ChildProcess|null} child Running process, if any.
 * @property {boolean} wantRunning Whether the supervisor should keep it alive.
 * @property {number} startedAt Epoch ms of the last start.
 * @property {number} failures Consecutive failed starts, drives the backoff.
 * @property {NodeJS.Timeout|null} restartTimer Pending restart.
 * @property {NodeJS.Timeout|null} killTimer Pending forced kill.
 * @property {{code: number|null, signal: string|null, at: number}|null} lastExit Last exit info.
 * @property {boolean} resyncPending Whether the next start must add --resync.
 * @property {ReturnType<typeof createRingBuffer>} buffer Recent client output.
 */

/** @type {Map<string, RunnerState>} */
const runners = new Map();

/**
 * Fetch or lazily create the runner state of an instance.
 * @param {string} id Instance id.
 * @returns {RunnerState} The runner state.
 */
function runnerFor(id) {
  let state = runners.get(id);
  if (!state) {
    state = {
      child: null,
      wantRunning: false,
      startedAt: 0,
      failures: 0,
      restartTimer: null,
      killTimer: null,
      lastExit: null,
      resyncPending: false,
      buffer: createRingBuffer(400),
    };
    runners.set(id, state);
  }
  return state;
}

/**
 * Append a line to an instance log and notify subscribers.
 * @param {string} id Instance id.
 * @param {string} line Text to record.
 * @returns {void}
 */
function record(id, line) {
  const state = runnerFor(id);
  state.buffer.push(line);
  events.emit("log", { id, line });
}

/** Notify subscribers that the state of an instance changed. */
function announce(id) {
  events.emit("state", { id, ...status(id) });
}

/**
 * Start the monitor process of an instance.
 *
 * Idempotent: starting an already running instance is a no-op, so the UI can
 * call it without tracking state itself.
 *
 * @param {object} instance Instance record.
 * @param {{resync?: boolean}} [opts] Whether this start performs a resync.
 * @returns {void}
 */
export function start(instance, opts = {}) {
  const state = runnerFor(instance.id);
  if (opts.resync) state.resyncPending = true;
  state.wantRunning = true;
  if (state.child) return;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
  spawnClient(instance);
}

/**
 * Spawn the client process for an instance and wire up its output.
 * @param {object} instance Instance record.
 * @returns {void}
 */
function spawnClient(instance) {
  const state = runnerFor(instance.id);
  const args = [...baseArgs(instance), "--monitor", "--verbose"];

  // A resync is a one-shot request: it applies to this start only, and
  // --resync-auth answers the interactive confirmation the client would
  // otherwise wait for forever in a container without a terminal.
  if (state.resyncPending) {
    args.push("--resync", "--resync-auth");
    state.resyncPending = false;
    record(instance.id, "[station] starting with --resync");
  }

  const invocation = clientCommand(args);
  const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "pipe", "pipe"] });
  state.child = child;
  state.startedAt = Date.now();
  state.lastExit = null;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => record(instance.id, chunk));
  child.stderr.on("data", (chunk) => record(instance.id, chunk));

  child.on("error", (err) => {
    record(instance.id, `[station] failed to start client: ${err.message}`);
    log.error("client spawn failed", { instance: instance.id, err: err.message });
  });

  child.on("exit", (code, signal) => handleExit(instance, code, signal));

  log.info("client started", { instance: instance.id, pid: child.pid });
  announce(instance.id);
}

/**
 * Handle a client exit: decide between an expected stop and a restart.
 * @param {object} instance Instance record.
 * @param {number|null} code Exit code.
 * @param {string|null} signal Terminating signal.
 * @returns {void}
 */
function handleExit(instance, code, signal) {
  const state = runnerFor(instance.id);
  const ranFor = Date.now() - state.startedAt;

  state.child = null;
  state.lastExit = { code, signal, at: Date.now() };
  if (state.killTimer) {
    clearTimeout(state.killTimer);
    state.killTimer = null;
  }

  record(instance.id, `[station] client exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
  log.info("client exited", { instance: instance.id, code, signal, ranFor });

  if (!state.wantRunning) {
    announce(instance.id);
    return;
  }

  // Exiting quickly after a start means the client could not do its job at all
  // (bad config, expired authorisation, no network). Backing off keeps a broken
  // instance from spinning; a client that ran for a while gets restarted
  // promptly, because that is a transient failure.
  const failedStart = ranFor < STARTUP_GRACE_MS;
  state.failures = failedStart ? state.failures + 1 : 0;
  const delay = failedStart
    ? Math.min(RESTART_BASE_MS * 2 ** (state.failures - 1), RESTART_MAX_MS)
    : RESTART_BASE_MS;

  record(instance.id, `[station] restarting in ${Math.round(delay / 1000)}s`);
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    if (state.wantRunning) spawnClient(instance);
  }, delay);
  announce(instance.id);
}

/**
 * Stop the client of an instance.
 *
 * SIGINT first: the client treats it as a shutdown request and closes its
 * database cleanly. Only a client that ignores it is killed, so an interrupted
 * transfer cannot leave the item database inconsistent.
 *
 * @param {string} id Instance id.
 * @returns {void}
 */
export function stop(id) {
  const state = runnerFor(id);
  state.wantRunning = false;
  state.failures = 0;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
  if (!state.child) {
    announce(id);
    return;
  }

  const child = state.child;
  record(id, "[station] stopping client");
  child.kill("SIGINT");
  state.killTimer = setTimeout(() => {
    if (state.child === child) {
      record(id, "[station] client did not stop in time, killing it");
      child.kill("SIGKILL");
    }
  }, STOP_GRACE_MS);
  announce(id);
}

/**
 * Restart the client of an instance, optionally forcing a resync.
 * @param {object} instance Instance record.
 * @param {{resync?: boolean}} [opts] Whether the restart performs a resync.
 * @returns {void}
 */
export function restart(instance, opts = {}) {
  const state = runnerFor(instance.id);
  if (opts.resync) state.resyncPending = true;

  if (!state.child) {
    start(instance, {});
    return;
  }
  // Stop, then let the exit handler bring it back up: waiting for the process to
  // actually be gone avoids two clients briefly sharing one config directory.
  const child = state.child;
  state.wantRunning = true;
  record(instance.id, "[station] restarting client");
  child.kill("SIGINT");
  state.killTimer = setTimeout(() => {
    if (state.child === child) child.kill("SIGKILL");
  }, STOP_GRACE_MS);
}

/**
 * Current runtime state of an instance.
 * @param {string} id Instance id.
 * @returns {{running: boolean, wantRunning: boolean, pid: number|null, startedAt: number, failures: number, lastExit: object|null, resyncPending: boolean}} State snapshot.
 */
export function status(id) {
  const state = runnerFor(id);
  return {
    running: Boolean(state.child),
    wantRunning: state.wantRunning,
    pid: state.child?.pid ?? null,
    startedAt: state.child ? state.startedAt : 0,
    failures: state.failures,
    lastExit: state.lastExit,
    resyncPending: state.resyncPending,
  };
}

/**
 * Recent client output of an instance.
 * @param {string} id Instance id.
 * @returns {Array<{ts: string, line: string}>} Buffered log lines.
 */
export function logs(id) {
  return runnerFor(id).buffer.list();
}

/**
 * Forget everything the supervisor holds for an instance. Called after the
 * instance was deleted so its log buffer does not leak.
 * @param {string} id Instance id.
 * @returns {void}
 */
export function forget(id) {
  const state = runners.get(id);
  if (!state) return;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  if (state.killTimer) clearTimeout(state.killTimer);
  state.buffer.clear();
  runners.delete(id);
}

/**
 * Stop every running client. Used on container shutdown so clients get their
 * SIGINT and close their databases instead of being killed with the container.
 * @returns {Promise<void>} Resolves once all clients exited or the grace period passed.
 */
export function stopAll() {
  const pending = [];
  for (const [id, state] of runners) {
    if (!state.child) continue;
    const child = state.child;
    pending.push(
      new Promise((resolve) => {
        // Whichever comes first wins, and the loser is cleaned up: a leftover
        // timer would keep the process alive well past the shutdown.
        const timer = setTimeout(resolve, STOP_GRACE_MS + 1000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      })
    );
    stop(id);
  }
  return Promise.all(pending).then(() => undefined);
}
