// Process supervision for the running sync clients.
//
// One child process per instance, started with --monitor so the client keeps
// syncing on its own. The supervisor owns the lifecycle: start, stop, restart,
// automatic restart after an unexpected exit, and the log tail the UI reads.
//
// A single container running N clients is intentional: the alternative, one
// container per account, would mean handing this container the Docker socket,
// which is a far larger privilege than running N child processes.
//
// Every lifecycle operation that ends a process returns a promise that settles
// when the process is actually gone. Callers depend on that: a sign-in or a
// logout must never run while a monitor still holds the same config directory,
// because both would touch the same item database and the same refresh token.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRingBuffer } from "./ringbuffer.js";
import { baseArgs, clientCommand } from "./onedrive.js";
import { localTimestamp } from "./time.js";
import { log } from "./logger.js";

/** Emits `log` and `state` events so the API can stream them to the browser. */
export const events = new EventEmitter();

// The API opens one listener pair per connected browser. The default limit of
// ten would print a leak warning from the eleventh open tab onwards, which is a
// perfectly normal number of viewers for a household.
events.setMaxListeners(100);

/** An exit within this window after start counts as a failed start. */
const STARTUP_GRACE_MS = 20_000;

/**
 * The client's own exit code for "a resync is required" (EXIT_RESYNC_REQUIRED
 * in its main.d). It reports this and stops whenever its configuration file
 * changed since the last run, which includes the very first run after a
 * sign-in, when there is no previous configuration to compare against.
 *
 * This is a request, not a crash: the answer is to start again with --resync
 * rather than to back off and retry the same thing.
 */
const EXIT_RESYNC_REQUIRED = 126;

/** How long to wait before the automatic restart that carries the resync. */
const RESYNC_RECOVERY_DELAY_MS = 1000;

/** Backoff bounds for automatic restarts after a failed start. */
const RESTART_BASE_MS = 5_000;
const RESTART_MAX_MS = 300_000;

/** How long a stopping client may take to exit before it is killed. */
const STOP_GRACE_MS = 15_000;

/**
 * @typedef {object} RunnerState
 * @property {import("node:child_process").ChildProcess|null} child Running process, if any.
 * @property {boolean} wantRunning Whether the supervisor should keep it alive.
 * @property {boolean} intentionalRestart Whether the current stop is a restart we asked for.
 * @property {number} startedAt Epoch ms of the last start.
 * @property {number} failures Consecutive failed starts, drives the backoff.
 * @property {NodeJS.Timeout|null} restartTimer Pending restart.
 * @property {NodeJS.Timeout|null} killTimer Pending forced kill.
 * @property {{code: number|null, signal: string|null, at: number}|null} lastExit Last exit info.
 * @property {boolean} resyncPending Whether the next start must add --resync.
 * @property {boolean} resyncRecoveryUsed Whether the one-shot resync recovery was already spent.
 * @property {boolean} stopRequested Whether this supervisor asked the client to stop.
 * @property {Array<() => void>} exitWaiters Resolvers waiting for the process to be gone.
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
      intentionalRestart: false,
      startedAt: 0,
      failures: 0,
      restartTimer: null,
      killTimer: null,
      lastExit: null,
      resyncPending: false,
      resyncRecoveryUsed: false,
      stopRequested: false,
      exitWaiters: [],
      buffer: createRingBuffer(400),
    };
    runners.set(id, state);
  }
  return state;
}

/**
 * Append client output to an instance log and notify subscribers.
 *
 * The chunk is split into lines and timestamped here, so the live stream and
 * the buffered log the UI fetches on open carry exactly the same shape. Sending
 * the raw chunk instead would give subscribers multi-line blobs without a
 * timestamp, and the two views would not line up.
 *
 * @param {string} id Instance id.
 * @param {string} chunk Raw client output, possibly several lines.
 * @returns {void}
 */
function record(id, chunk) {
  const state = runnerFor(id);
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line) continue;
    const entry = { ts: localTimestamp(), line };
    state.buffer.pushEntry(entry);
    events.emit("log", { id, ...entry });
  }
}

/**
 * Notify subscribers that the state of an instance changed.
 * @param {string} id Instance id.
 * @returns {void}
 */
function announce(id) {
  events.emit("state", { id, ...status(id) });
}

/**
 * Clear a pending timer field on the runner state.
 * @param {RunnerState} state Runner state.
 * @param {"restartTimer"|"killTimer"} field Which timer to clear.
 * @returns {void}
 */
function clearTimer(state, field) {
  if (state[field]) {
    clearTimeout(state[field]);
    state[field] = null;
  }
}

/**
 * Release everyone waiting for this instance's process to be gone.
 * @param {RunnerState} state Runner state.
 * @returns {void}
 */
function releaseExitWaiters(state) {
  const waiters = state.exitWaiters.splice(0);
  for (const resolve of waiters) resolve();
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
  clearTimer(state, "restartTimer");
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
  // --resync-auth answers the confirmation the client would otherwise wait for
  // forever in a container without a terminal.
  const resyncing = state.resyncPending;
  if (resyncing) {
    args.push("--resync", "--resync-auth");
    state.resyncPending = false;
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

  // A spawn that never gets off the ground emits 'error' and 'close', but no
  // 'exit'. Without handling it here the runner would keep a child reference
  // that can never be cleared, and the instance would report itself as running
  // forever while doing nothing. Common causes are a missing binary and, in a
  // container that hit its process or memory limit, EAGAIN or ENOMEM.
  child.on("error", (err) => {
    record(instance.id, `[station] failed to start client: ${err.message}`);
    log.error("client spawn failed", { instance: instance.id, err: err.message });
    if (state.child === child) handleGone(instance, null, null, { spawnFailed: true });
  });

  child.on("exit", (code, signal) => {
    if (state.child === child) handleGone(instance, code, signal, {});
  });

  if (resyncing) record(instance.id, "[station] starting with --resync");
  log.info("client started", { instance: instance.id, pid: child.pid, resync: resyncing });
  announce(instance.id);
}

/**
 * Handle a client that is gone, whether it exited or never started.
 * @param {object} instance Instance record.
 * @param {number|null} code Exit code.
 * @param {string|null} signal Terminating signal.
 * @param {{spawnFailed?: boolean}} opts Whether the process failed to spawn at all.
 * @returns {void}
 */
function handleGone(instance, code, signal, opts) {
  const state = runnerFor(instance.id);
  const ranFor = Date.now() - state.startedAt;
  const wasIntentional = state.intentionalRestart;

  state.child = null;
  state.intentionalRestart = false;
  state.lastExit = {
    code,
    signal,
    at: Date.now(),
    spawnFailed: Boolean(opts.spawnFailed),
    requested: state.stopRequested,
  };
  state.stopRequested = false;
  clearTimer(state, "killTimer");
  releaseExitWaiters(state);

  if (!opts.spawnFailed) {
    record(
      instance.id,
      `[station] client exited (code ${code ?? "none"}, signal ${signal ?? "none"})`
    );
    log.info("client exited", { instance: instance.id, code, signal, ranFor });
  }

  if (!state.wantRunning) {
    announce(instance.id);
    return;
  }

  // The client asked for a resync instead of failing. Grant it once and start
  // again straight away: backing off would only repeat the same request, which
  // is what makes an account look permanently broken after any configuration
  // change. Granting it only once keeps a client that asks again from looping,
  // and the counter resets as soon as a start survives the grace period.
  if (code === EXIT_RESYNC_REQUIRED && !state.resyncRecoveryUsed) {
    state.resyncRecoveryUsed = true;
    state.resyncPending = true;
    record(instance.id, "[station] the client requires a resync, restarting with --resync");
    log.info("resync required by client", { instance: instance.id });
    clearTimer(state, "restartTimer");
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (state.wantRunning) spawnClient(instance);
    }, RESYNC_RECOVERY_DELAY_MS);
    announce(instance.id);
    return;
  }

  // Exiting quickly after a start means the client could not do its job at all
  // (bad config, expired authorisation, no network). Backing off keeps a broken
  // instance from spinning. A restart we asked for is excluded: without that,
  // saving the folder selection a few times in a row would look like a crash
  // loop and push the instance into a five minute backoff.
  const failedStart = !wasIntentional && (opts.spawnFailed || ranFor < STARTUP_GRACE_MS);
  state.failures = failedStart ? state.failures + 1 : 0;
  // A start that survived the grace period proves the client is working again,
  // so the one-shot resync recovery is available for the next configuration
  // change instead of being spent for the lifetime of the container.
  if (!failedStart) state.resyncRecoveryUsed = false;
  const delay = failedStart
    ? Math.min(RESTART_BASE_MS * 2 ** (state.failures - 1), RESTART_MAX_MS)
    : RESTART_BASE_MS;

  record(instance.id, `[station] restarting in ${Math.round(delay / 1000)}s`);
  clearTimer(state, "restartTimer");
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    if (state.wantRunning) spawnClient(instance);
  }, delay);
  announce(instance.id);
}

/**
 * Ask a running child to stop and force the issue if it does not.
 *
 * SIGINT first: the client treats it as a shutdown request and closes its item
 * database cleanly. Only a client that ignores it is killed, so an interrupted
 * transfer cannot leave the database inconsistent.
 *
 * @param {RunnerState} state Runner state holding the child.
 * @param {string} id Instance id, for the log line.
 * @returns {void}
 */
function signalStop(state, id) {
  const child = state.child;
  if (!child) return;
  // Recorded so the exit can be told apart from a crash. The client handles
  // SIGINT itself and then exits with code 130, so the exit looks like an
  // ordinary non-zero code and cannot be recognised by the code alone.
  state.stopRequested = true;
  child.kill("SIGINT");
  clearTimer(state, "killTimer");
  state.killTimer = setTimeout(() => {
    if (state.child === child) {
      record(id, "[station] client did not stop in time, killing it");
      child.kill("SIGKILL");
    }
  }, STOP_GRACE_MS);
}

/**
 * Stop the client of an instance and wait until it is really gone.
 *
 * The returned promise is the contract callers rely on before they touch the
 * instance's config directory: a resolved promise means no client process of
 * this instance is running any more.
 *
 * @param {string} id Instance id.
 * @returns {Promise<void>} Resolves once no process is running.
 */
export function stop(id) {
  const state = runnerFor(id);
  state.wantRunning = false;
  state.failures = 0;
  // A queued resync belongs to the run that was just cancelled. Keeping it
  // would silently turn the user's next plain "start" into a resync, and
  // --resync-auth would auto-answer the very confirmation that normally guards
  // discarding the local database.
  state.resyncPending = false;
  clearTimer(state, "restartTimer");

  if (!state.child) {
    announce(id);
    return Promise.resolve();
  }

  record(id, "[station] stopping client");
  const gone = new Promise((resolve) => state.exitWaiters.push(resolve));
  signalStop(state, id);
  announce(id);
  return gone;
}

/**
 * Restart the client of an instance, optionally forcing a resync.
 * @param {object} instance Instance record.
 * @param {{resync?: boolean}} [opts] Whether the restart performs a resync.
 * @returns {Promise<void>} Resolves once the client has been asked to restart.
 */
export function restart(instance, opts = {}) {
  const state = runnerFor(instance.id);
  if (opts.resync) state.resyncPending = true;

  if (!state.child) {
    start(instance, {});
    return Promise.resolve();
  }

  // Stop, then let the exit handler bring it back up: waiting for the process
  // to actually be gone avoids two clients briefly sharing one config
  // directory.
  state.wantRunning = true;
  state.intentionalRestart = true;
  record(instance.id, "[station] restarting client");
  const gone = new Promise((resolve) => state.exitWaiters.push(resolve));
  signalStop(state, instance.id);
  return gone;
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
  clearTimer(state, "restartTimer");
  clearTimer(state, "killTimer");
  releaseExitWaiters(state);
  state.buffer.clear();
  runners.delete(id);
}

/**
 * Stop every client. Used on container shutdown so clients get their SIGINT and
 * close their databases instead of being killed with the container.
 *
 * Every known runner is stopped, not only those with a live process: an
 * instance waiting out its restart backoff has no child but an armed timer, and
 * skipping it would let that timer spawn a fresh client in the middle of the
 * shutdown.
 *
 * @returns {Promise<void>} Resolves once all clients are gone or the grace period passed.
 */
export function stopAll() {
  const pending = [];
  for (const id of runners.keys()) {
    pending.push(
      Promise.race([
        stop(id),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, STOP_GRACE_MS + 1000);
          // Do not let the safety net keep the process alive on its own.
          timer.unref?.();
        }),
      ])
    );
  }
  return Promise.all(pending).then(() => undefined);
}
