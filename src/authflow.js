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

const POLL_INTERVAL_MS = 250;

/**
 * @typedef {object} PendingAuth
 * @property {import("node:child_process").ChildProcess} child The waiting client.
 * @property {string} authUrl The URL the user has to open.
 * @property {string} urlFile Path of the file the client wrote the URL to.
 * @property {string} responseFile Path of the file the client waits for.
 * @property {ReturnType<typeof createRingBuffer>} output Client output, for diagnostics.
 * @property {NodeJS.Timeout} timeout Abandons the attempt when the user never returns.
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
 * @returns {Promise<string|null>} File contents, or null on timeout.
 */
async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const contents = readFileSync(file, "utf8").trim();
      if (contents) return contents;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Remove the handshake files of an instance.
 * @param {string} urlFile Path of the URL file.
 * @param {string} responseFile Path of the response file.
 * @returns {void}
 */
function clearFiles(urlFile, responseFile) {
  rmSync(urlFile, { force: true });
  rmSync(responseFile, { force: true });
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
 * @returns {string|null} The URL or null.
 */
export function pendingUrl(id) {
  return pending.get(id)?.authUrl ?? null;
}

/**
 * Start a sign-in and return the URL the user has to open.
 *
 * The caller must make sure the monitor process of this instance is stopped:
 * two clients sharing one config directory would race over the same token
 * files. The API layer enforces that before calling in.
 *
 * @param {object} instance Instance record.
 * @returns {Promise<{authUrl: string}>} The authorisation URL.
 * @throws {Error} When the client never produced a URL.
 */
export async function begin(instance) {
  cancel(instance.id);

  mkdirSync(AUTH_DIR, { recursive: true });
  const urlFile = join(AUTH_DIR, `${instance.id}.url`);
  const responseFile = join(AUTH_DIR, `${instance.id}.response`);
  clearFiles(urlFile, responseFile);

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
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const authUrl = await waitForFile(urlFile, URL_WAIT_MS);
  if (!authUrl) {
    child.kill("SIGKILL");
    clearFiles(urlFile, responseFile);
    const details = output
      .list()
      .map((entry) => entry.line)
      .join("\n");
    throw new Error(`client did not produce an authorisation URL. Output:\n${details}`);
  }

  // Abandon the attempt if the user never comes back, so a forgotten browser
  // tab does not leave a client process waiting forever.
  const timeout = setTimeout(() => cancel(instance.id), SIGN_IN_TIMEOUT_MS);

  pending.set(instance.id, { child, authUrl, urlFile, responseFile, output, timeout, exited });
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
  if (!attempt) throw new ValidationError("responseUrl", "no-pending-sign-in");

  const url = validate.authResponseUrl(responseUrl);
  writeFileSync(attempt.responseFile, url + "\n", { mode: 0o600 });

  // The client polls for the file, redeems the code and exits. Waiting for that
  // exit is what tells us whether the sign-in actually succeeded.
  const result = await withDeadline(attempt.exited, REDEEM_TIMEOUT_MS);

  clearTimeout(attempt.timeout);
  clearFiles(attempt.urlFile, attempt.responseFile);
  pending.delete(instance.id);

  const text = attempt.output
    .list()
    .map((entry) => entry.line)
    .join("\n");

  if (result === null) {
    attempt.child.kill("SIGKILL");
    return { ok: false, text: `${text}\n[station] client did not finish in time` };
  }

  const ok = result.code === 0;
  log.info("sign-in finished", { instance: instance.id, ok, code: result.code });
  return { ok, text };
}

/**
 * Abort a pending sign-in and clean up after it.
 * @param {string} id Instance id.
 * @returns {void}
 */
export function cancel(id) {
  const attempt = pending.get(id);
  if (!attempt) return;
  clearTimeout(attempt.timeout);
  attempt.child.kill("SIGKILL");
  clearFiles(attempt.urlFile, attempt.responseFile);
  pending.delete(id);
  log.info("sign-in cancelled", { instance: id });
}
