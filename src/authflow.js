// Microsoft sign-in for an instance, driven from the web UI.
//
// The client cannot prompt a user inside a container, so it offers a file based
// handshake: `--auth-files <authUrl>:<responseUrl>` makes it write the
// authorisation URL to one file and then wait for a second file to appear that
// contains the redirect URL the user was sent to. That is exactly the hook a
// web UI needs, and it works identically for Personal, Business and SharePoint
// accounts.
//
// Flow:
//   1. begin()    - spawn the client, wait for the URL file, hand the URL to the UI
//   2. user       - opens the URL, signs in, lands on a blank page
//   3. complete() - the pasted redirect URL is written to the response file, the
//                   client redeems the code and exits
//
// No client secret is involved anywhere: the upstream client is registered as a
// public client application and uses delegated permissions.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AUTH_DIR } from "./config.js";
import { baseArgs, clientCommand } from "./onedrive.js";
import { createRingBuffer } from "./ringbuffer.js";
import * as validate from "./validate.js";
import { ValidationError } from "./validate.js";
import { log } from "./logger.js";

/**
 * Failure of the sign-in handshake itself, as opposed to bad user input.
 *
 * Carries a status code so the API reports it as a client-visible problem with
 * the client's own output attached, instead of collapsing into a generic 500
 * that tells the user nothing about why the sign-in never started.
 */
export class AuthFlowError extends Error {
  /**
   * @param {string} message Human readable explanation, including client output.
   */
  constructor(message) {
    super(message);
    this.name = "AuthFlowError";
    this.statusCode = 502;
  }
}

/**
 * Command that carries the sign-in.
 *
 * The handshake needs an action that actually reaches Microsoft, otherwise the
 * client has no reason to authorise. --display-quota is the cheapest such call:
 * it authenticates, prints the account quota and exits, which doubles as proof
 * that the fresh token really works.
 */
const AUTH_CARRIER_ARGS = ["--display-quota"];

/** How long to wait for the client to produce the authorisation URL. */
const URL_WAIT_MS = 60_000;

/** How long a user may take to complete the sign-in before we give up. */
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;

/** How long the client may take to redeem the code once the response arrives. */
const REDEEM_TIMEOUT_MS = 120_000;

/** How long a killed client may take to disappear before we stop waiting. */
const KILL_TIMEOUT_MS = 5_000;

const POLL_INTERVAL_MS = 250;

/**
 * Recognise the device code prompt in the client's output.
 *
 * With use_device_auth the client prints the verification URL on its own line
 * and the code in a sentence, then polls Microsoft by itself until the user has
 * confirmed. Nothing has to be copied back, which is why this flow exists: the
 * redirect page of the other flow redirects itself away before most people can
 * copy the address out of it.
 *
 * @param {string} text Client output collected so far.
 * @returns {{verificationUrl: string, userCode: string}|null} The prompt, once both parts are present.
 */
export function parseDeviceCodePrompt(text) {
  const codeMatch = String(text).match(/Enter the following code when prompted:\s*(\S+)/i);
  if (!codeMatch) return null;
  // The client prints the URL Microsoft supplied, on a line of its own.
  const urlMatch = String(text).match(/https:\/\/\S*(?:devicelogin|deviceauth)\S*/i);
  return {
    verificationUrl: urlMatch ? urlMatch[0].replace(/[.,]$/, "") : "https://microsoft.com/devicelogin",
    userCode: codeMatch[1],
  };
}

/**
 * @typedef {object} PendingAuth
 * @property {import("node:child_process").ChildProcess} child The waiting client.
 * @property {"redirect"|"device"} mode Which sign-in flow this attempt uses.
 * @property {{verificationUrl: string, userCode: string}|null} devicePrompt Device code details, when in device mode.
 * @property {string|null} authUrl The URL the user has to open, once known.
 * @property {string} urlFile Path of the file the client wrote the URL to.
 * @property {string} responseFile Path of the file the client waits for.
 * @property {ReturnType<typeof createRingBuffer>} output Client output, for diagnostics.
 * @property {NodeJS.Timeout|null} timeout Abandons the attempt when the user never returns.
 * @property {Promise<{code: number|null, signal: string|null}>} exited Resolves when the client exits.
 */

/** @type {Map<string, PendingAuth>} */
const pending = new Map();

/**
 * Sleep helper for the file polling loops.
 * @param {number} ms Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the delay.
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a deadline and always clear the timer afterwards.
 *
 * A bare `Promise.race` with a `setTimeout` leaves the timer running when the
 * promise wins, which keeps the process alive for the full timeout even though
 * the work is long done.
 *
 * @template T
 * @param {Promise<T>} promise Work to await.
 * @param {number} ms Deadline in milliseconds.
 * @returns {Promise<T|null>} The result, or null when the deadline hit first.
 */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Wait until a file exists and has content.
 * @param {string} file Path to watch.
 * @param {number} timeoutMs Maximum time to wait.
 * @param {() => boolean} stillWanted Abort early when this returns false.
 * @returns {Promise<string|null>} File contents, or null on timeout or abort.
 */
async function waitForFile(file, timeoutMs, stillWanted) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!stillWanted()) return null;
    if (existsSync(file)) {
      const contents = readFileSync(file, "utf8").trim();
      if (contents) return contents;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Remove the handshake files of an attempt.
 * @param {PendingAuth} attempt The attempt whose files to remove.
 * @returns {void}
 */
function clearFiles(attempt) {
  rmSync(attempt.urlFile, { force: true });
  rmSync(attempt.responseFile, { force: true });
}

/**
 * Collect the client output of an attempt as text.
 * @param {PendingAuth} attempt The attempt to read.
 * @returns {string} The output, newline separated.
 */
function outputText(attempt) {
  return attempt.output
    .list()
    .map((entry) => entry.line)
    .join("\n");
}

/**
 * Whether a sign-in is currently waiting for user input.
 * @param {string} id Instance id.
 * @returns {boolean} True when an attempt is pending.
 */
export function isPending(id) {
  return pending.has(id);
}

/**
 * The authorisation URL of a pending sign-in, if any.
 * @param {string} id Instance id.
 * @returns {string|null} The URL, or null when there is none yet.
 */
export function pendingUrl(id) {
  return pending.get(id)?.authUrl ?? null;
}

/**
 * Start a sign-in and return the URL the user has to open.
 *
 * The caller must make sure the monitor process of this instance has actually
 * stopped: two clients sharing one config directory would race over the same
 * item database and token files.
 *
 * @param {object} instance Instance record.
 * @returns {Promise<{authUrl: string}>} The authorisation URL.
 * @throws {AuthFlowError} When the client never produced a URL, or the attempt was superseded.
 */
export async function begin(instance) {
  await cancel(instance.id);

  mkdirSync(AUTH_DIR, { recursive: true });
  const urlFile = join(AUTH_DIR, `${instance.id}.url`);
  const responseFile = join(AUTH_DIR, `${instance.id}.response`);
  rmSync(urlFile, { force: true });
  rmSync(responseFile, { force: true });

  const args = [
    ...baseArgs(instance),
    "--auth-files",
    `${urlFile}:${responseFile}`,
    ...AUTH_CARRIER_ARGS,
  ];

  const invocation = clientCommand(args);
  const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "pipe", "pipe"] });
  const output = createRingBuffer(200);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));

  const exited = new Promise((resolve) => {
    // 'exit' never fires when the spawn itself failed, so 'close' is the event
    // that is guaranteed to arrive in both cases.
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  /** @type {PendingAuth} */
  const attempt = {
    child,
    mode: "redirect",
    devicePrompt: null,
    authUrl: null,
    urlFile,
    responseFile,
    output,
    timeout: null,
    exited,
  };

  // Registered before the first await: a second begin() for the same instance
  // (a double click, a UI retry) must be able to find and kill this attempt.
  // Registering only after the URL arrived would leave an orphan client holding
  // the config directory, still polling for a response file, ready to complete
  // a sign-in the user believes they cancelled.
  pending.set(instance.id, attempt);

  const authUrl = await waitForFile(urlFile, URL_WAIT_MS, () => pending.get(instance.id) === attempt);

  if (pending.get(instance.id) !== attempt) {
    // Someone started a newer attempt, or cancelled this one, while we waited.
    child.kill("SIGKILL");
    throw new AuthFlowError("the sign-in was superseded by a newer attempt");
  }

  if (!authUrl) {
    child.kill("SIGKILL");
    clearFiles(attempt);
    pending.delete(instance.id);
    throw new AuthFlowError(
      `the client did not produce an authorisation URL.\n${outputText(attempt)}`
    );
  }

  attempt.authUrl = authUrl;
  // Abandon the attempt if the user never comes back, so a forgotten browser
  // tab does not leave a client process holding the config directory forever.
  attempt.timeout = setTimeout(() => {
    cancel(instance.id).catch(() => {});
  }, SIGN_IN_TIMEOUT_MS);

  log.info("sign-in started", { instance: instance.id });
  return { authUrl };
}

/**
 * Finish a sign-in with the redirect URL the user pasted back.
 * @param {object} instance Instance record.
 * @param {string} responseUrl The redirect URL from the browser address bar.
 * @returns {Promise<{ok: boolean, text: string}>} Client output and success flag.
 * @throws {ValidationError} When no sign-in is pending or the URL is invalid.
 */
export async function complete(instance, responseUrl) {
  const attempt = pending.get(instance.id);
  if (!attempt || !attempt.authUrl) throw new ValidationError("responseUrl", "no-pending-sign-in");

  const url = validate.authResponseUrl(responseUrl);
  writeFileSync(attempt.responseFile, url + "\n", { mode: 0o600 });

  // The client polls for the file, redeems the code and exits. Waiting for that
  // exit is what tells us whether the sign-in actually succeeded.
  const result = await withDeadline(attempt.exited, REDEEM_TIMEOUT_MS);

  if (attempt.timeout) clearTimeout(attempt.timeout);
  clearFiles(attempt);
  // Only drop the registration if it is still ours: a cancel that raced with us
  // may already have replaced it.
  if (pending.get(instance.id) === attempt) pending.delete(instance.id);

  const text = outputText(attempt);

  if (result === null) {
    attempt.child.kill("SIGKILL");
    return { ok: false, text: `${text}\n[station] the client did not finish in time` };
  }

  const ok = result.code === 0;
  log.info("sign-in finished", { instance: instance.id, ok, code: result.code });
  return { ok, text };
}

/**
 * Start a sign-in that uses a device code.
 *
 * Unlike the redirect flow this needs no second step from the station: the
 * client polls Microsoft on its own until the user has entered the code, then
 * writes its refresh token and exits. The caller only has to watch for that.
 *
 * The instance must have use_device_auth enabled in its client config, which
 * instances.js writes from the account's options.
 *
 * @param {object} instance Instance record.
 * @returns {Promise<{verificationUrl: string, userCode: string}>} What the user has to enter, and where.
 * @throws {AuthFlowError} When the client never printed a code.
 */
export async function beginDeviceAuth(instance) {
  await cancel(instance.id);

  const args = [...baseArgs(instance), ...AUTH_CARRIER_ARGS];
  const invocation = clientCommand(args);
  const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "pipe", "pipe"] });

  const output = createRingBuffer(200);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));

  const exited = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  /** @type {PendingAuth} */
  const attempt = {
    child,
    mode: "device",
    devicePrompt: null,
    authUrl: null,
    // No handshake files in this flow; the fields stay set so cancel() and the
    // cleanup helpers can treat both modes alike.
    urlFile: join(AUTH_DIR, `${instance.id}.url`),
    responseFile: join(AUTH_DIR, `${instance.id}.response`),
    output,
    timeout: null,
    exited,
  };
  pending.set(instance.id, attempt);

  // Poll the collected output until the client has printed the code. It cannot
  // be read from a file here, so this watches the buffer instead.
  const deadline = Date.now() + URL_WAIT_MS;
  while (Date.now() < deadline) {
    if (pending.get(instance.id) !== attempt) {
      child.kill("SIGKILL");
      throw new AuthFlowError("the sign-in was superseded by a newer attempt");
    }
    const prompt = parseDeviceCodePrompt(outputText(attempt));
    if (prompt) {
      attempt.devicePrompt = prompt;
      // The code expires on Microsoft's side; give up a little later than that
      // so a forgotten attempt cannot hold the config directory forever.
      attempt.timeout = setTimeout(() => {
        cancel(instance.id).catch(() => {});
      }, SIGN_IN_TIMEOUT_MS);
      log.info("device sign-in started", { instance: instance.id });
      return prompt;
    }
    // The client may also fail before printing anything, for example when the
    // tenant forbids this flow. Surfacing its own words beats a timeout.
    const finished = await withDeadline(exited, POLL_INTERVAL_MS);
    if (finished) {
      pending.delete(instance.id);
      throw new AuthFlowError(`the client stopped before showing a code.\n${outputText(attempt)}`);
    }
  }

  child.kill("SIGKILL");
  pending.delete(instance.id);
  throw new AuthFlowError(`the client did not show a device code.\n${outputText(attempt)}`);
}

/**
 * State of a pending sign-in, for the UI to poll while the user is at Microsoft.
 * @param {object} instance Instance record.
 * @returns {{pending: boolean, mode: string|null, devicePrompt: object|null, output: string}} Current state.
 */
export function attemptState(instance) {
  const attempt = pending.get(instance.id);
  if (!attempt) return { pending: false, mode: null, devicePrompt: null, output: "" };
  return {
    pending: true,
    mode: attempt.mode,
    devicePrompt: attempt.devicePrompt,
    output: outputText(attempt),
  };
}

/**
 * Wait for a device sign-in to finish, without blocking the request.
 *
 * Resolves as soon as the client exits, or reports that it is still waiting for
 * the user. The UI calls this repeatedly, so it must always return quickly.
 *
 * @param {object} instance Instance record.
 * @param {number} [waitMs] How long to wait for the client before answering.
 * @returns {Promise<{done: boolean, ok?: boolean, text?: string}>} Whether the sign-in completed.
 */
export async function pollDeviceAuth(instance, waitMs = 2000) {
  const attempt = pending.get(instance.id);
  if (!attempt) return { done: true, ok: false, text: "no sign-in is pending" };

  const result = await withDeadline(attempt.exited, waitMs);
  if (!result) return { done: false };

  if (attempt.timeout) clearTimeout(attempt.timeout);
  if (pending.get(instance.id) === attempt) pending.delete(instance.id);

  const ok = result.code === 0;
  log.info("device sign-in finished", { instance: instance.id, ok, code: result.code });
  return { done: true, ok, text: outputText(attempt) };
}

/**
 * Abort a pending sign-in and wait until its client is gone.
 *
 * Awaiting the exit matters: callers cancel a sign-in right before deleting the
 * instance's config directory, and a client still running against a deleted
 * directory would keep writing into nowhere.
 *
 * @param {string} id Instance id.
 * @returns {Promise<void>} Resolves once no sign-in client of this instance runs.
 */
export async function cancel(id) {
  const attempt = pending.get(id);
  if (!attempt) return;

  // Deregister first: the begin() that owns this attempt polls the registration
  // and stops as soon as it is no longer the current one.
  pending.delete(id);
  if (attempt.timeout) clearTimeout(attempt.timeout);
  attempt.child.kill("SIGKILL");
  await withDeadline(attempt.exited, KILL_TIMEOUT_MS);
  clearFiles(attempt);
  log.info("sign-in cancelled", { instance: id });
}
