// Thin wrapper around the abraunegg OneDrive Client for Linux.
//
// Everything here is a one-shot invocation that finishes on its own. Long
// running monitor processes live in supervisor.js, the file based sign-in lives
// in authflow.js; both build their arguments with baseArgs() from here so there
// is exactly one place that knows how the client is addressed.
//
// The client is always spawned with an argv array and never through a shell, so
// no value can be interpreted as a shell command. Values that could still be
// mistaken for another client flag are rejected in validate.js.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { instanceConfDir, instanceDataDir } from "./config.js";

const execFileAsync = promisify(execFile);

/** Client binary; overridable so tests and dev runs can point at a stub. */
export const ONEDRIVE_BIN = process.env.ONEDRIVE_BIN || "onedrive";

/** Default timeout for one-shot commands that only talk to the local config. */
const LOCAL_TIMEOUT_MS = 30_000;

/** Timeout for commands that query the Microsoft Graph API. */
const REMOTE_TIMEOUT_MS = 120_000;

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The client's refusal to run while it considers a resync outstanding. */
const RESYNC_DEMANDED = /resync is required/i;

/** Name the client stores its refresh token under inside a config directory. */
const TOKEN_FILE = "refresh_token";

/**
 * Arguments every invocation for an instance needs.
 *
 * Both paths are passed explicitly on every call instead of being written into
 * the client config file, mirroring what the upstream container does: the
 * command line then always wins and file and arguments cannot drift apart.
 *
 * @param {object} instance Instance record.
 * @returns {string[]} The base argument list.
 */
export function baseArgs(instance) {
  return [
    "--confdir",
    instanceConfDir(instance.id),
    "--syncdir",
    instanceDataDir(instance.folder),
  ];
}

/**
 * Resolve how the client is invoked.
 *
 * Normally this is the client binary with the given arguments. If ONEDRIVE_BIN
 * points at a Node script instead, it is run through the current Node
 * executable: that is what lets the tests drive a stub client, and it works on
 * every platform without a shebang or an executable bit.
 *
 * @param {string[]} args Client arguments.
 * @returns {{command: string, args: string[]}} Command and arguments to spawn.
 */
export function clientCommand(args) {
  // Gated on the environment: in a production container the client is always a
  // real binary, and this branch has no business being reachable there.
  if (process.env.NODE_ENV !== "production" && /\.m?js$/i.test(ONEDRIVE_BIN)) {
    return { command: process.execPath, args: [ONEDRIVE_BIN, ...args] };
  }
  return { command: ONEDRIVE_BIN, args };
}

/**
 * Run a one-shot client command.
 * @param {string[]} args Full argument list.
 * @param {{timeout?: number}} [opts] Optional timeout override.
 * @returns {Promise<{ok: boolean, text: string}>} Combined output and success flag.
 */
export async function run(args, opts = {}) {
  const invocation = clientCommand(args);
  try {
    const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
      timeout: opts.timeout ?? LOCAL_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { ok: true, text: `${stdout || ""}${stderr || ""}`.trim() };
  } catch (err) {
    // Only the client's own output is passed on. err.message would be
    // "Command failed: onedrive --confdir /config/instances/... --syncdir ...",
    // which puts host paths and the full command line in front of the user for
    // no diagnostic gain.
    const text = `${err.stdout || ""}${err.stderr || ""}`.trim();
    return { ok: false, text: text || `the client failed (${err.code ?? "no exit code"})` };
  }
}

/** Cached result of `--version`; it can only change when the image changes. */
let versionCache = null;

/**
 * Client version string, also used as the installation check.
 *
 * The result is cached for the lifetime of the process. This is read by the
 * unauthenticated state endpoint, and without the cache every anonymous request
 * would spawn a client process, which is a cheap way for anyone on the network
 * to exhaust the container's process limit.
 *
 * @returns {Promise<{ok: boolean, text: string}>} Version output.
 */
export async function version() {
  if (!versionCache) versionCache = await run(["--version"]);
  return versionCache;
}

/**
 * Effective configuration of an instance as the client sees it.
 * @param {object} instance Instance record.
 * @returns {Promise<{ok: boolean, text: string}>} Client output.
 */
export function displayConfig(instance) {
  return run([...baseArgs(instance), "--display-config"]);
}

/**
 * Pending remote changes for an instance.
 * @param {object} instance Instance record.
 * @returns {Promise<{ok: boolean, text: string}>} Client output.
 */
export function displaySyncStatus(instance) {
  return run([...baseArgs(instance), "--display-sync-status"], { timeout: REMOTE_TIMEOUT_MS });
}

/**
 * Storage quota of the account behind an instance.
 * @param {object} instance Instance record.
 * @returns {Promise<{ok: boolean, text: string}>} Client output.
 */
export function displayQuota(instance) {
  return run([...baseArgs(instance), "--display-quota"], { timeout: REMOTE_TIMEOUT_MS });
}

/**
 * Preview what a sync would do, without transferring anything. Used to let the
 * user check a sync_list before committing to a resync.
 * @param {object} instance Instance record.
 * @returns {Promise<{ok: boolean, text: string}>} Client output.
 */
export function dryRun(instance) {
  return run([...baseArgs(instance), "--sync", "--dry-run", "--verbose"], {
    timeout: REMOTE_TIMEOUT_MS,
  });
}

/**
 * Tenant specific admin consent URL, for tenants that require an administrator
 * to approve the application before users can sign in.
 * @param {object} instance Instance record.
 * @returns {Promise<{ok: boolean, text: string}>} Client output.
 */
export function displayAdminConsentUrl(instance) {
  return run([...baseArgs(instance), "--display-admin-consent-url"]);
}

/**
 * Business shared items available to the signed-in account.
 * @param {object} instance Instance record.
 * @returns {Promise<{ok: boolean, text: string}>} Client output.
 */
export function listSharedItems(instance) {
  return run([...baseArgs(instance), "--list-shared-items"], { timeout: REMOTE_TIMEOUT_MS });
}

/**
 * Sign an instance out and discard its stored tokens.
 * @param {object} instance Instance record.
 * @returns {Promise<{ok: boolean, text: string}>} Client output.
 */
export function logout(instance) {
  return run([...baseArgs(instance), "--logout"]);
}

/**
 * Parse the drive ids out of a `--get-sharepoint-drive-id` response.
 *
 * The client prints a human readable block per matching library rather than
 * structured data, so this stays deliberately tolerant: it collects every
 * drive id it can see together with the nearest preceding library name. The
 * raw text is returned alongside so the UI can fall back to showing it when the
 * output format changes.
 *
 * @param {string} text Raw client output.
 * @returns {Array<{name: string, driveId: string}>} Recognised libraries.
 */
export function parseSharePointDriveIds(text) {
  const libraries = [];
  let lastName = "";
  for (const line of String(text).split(/\r?\n/)) {
    const nameMatch = line.match(/(?:Library Name|Site Name|Name)\s*[:=]\s*(.+?)\s*$/i);
    if (nameMatch) {
      lastName = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const idMatch = line.match(/drive[_ ]?id\s*[:=]\s*["']?([A-Za-z0-9!_\-.=]+)["']?/i);
    if (idMatch) {
      libraries.push({ name: lastName, driveId: idMatch[1] });
      lastName = "";
    }
  }
  return libraries;
}

/**
 * Reduce whatever was pasted into the site field to a site name.
 *
 * The client searches for a site by name and finds nothing when handed a full
 * address, which is the obvious thing to paste: the browser is open on the
 * library anyway. Everything after the site segment is a library and view path
 * and has no bearing on the lookup.
 *
 * @param {string} value Site name or any SharePoint URL.
 * @returns {string} The site name, or the input unchanged when it is not a URL.
 */
export function siteNameFrom(value) {
  const raw = String(value).trim();
  const match = raw.match(new RegExp("/(?:sites|teams)/([^/?#]+)", "i"));
  if (!match) return raw;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1]; // a stray percent sign is not a reason to fail the lookup
  }
}

/**
 * Query the drive ids of the SharePoint libraries of a site.
 *
 * Requires an instance that is already signed in with an account that can see
 * the site: the lookup runs as that account.
 *
 * @param {object} instance Signed-in instance used for the lookup.
 * @param {string} siteName Site name or URL to search for, already validated.
 * @returns {Promise<{ok: boolean, text: string, libraries: Array<{name: string, driveId: string}>}>} Result.
 */
export async function getSharePointDriveId(instance, siteName) {
  const site = siteNameFrom(siteName);
  // Which route the lookup took. Reported so a failure can be read without
  // guessing from the client's output which of the two runs produced it.
  let attempt = "direct";
  let res = await run([...baseArgs(instance), "--get-sharepoint-drive-id", site], {
    timeout: REMOTE_TIMEOUT_MS,
  });

  if (!res.ok && RESYNC_DEMANDED.test(res.text)) {
    const fallback = await lookupInScratchDir(instance, site);
    if (fallback) {
      res = fallback;
      attempt = RESYNC_DEMANDED.test(fallback.text) ? "isolated-still-refused" : "isolated";
    } else {
      attempt = "no-token";
    }
  }

  return {
    ...res,
    site,
    attempt,
    isolated: attempt.startsWith("isolated"),
    libraries: res.ok ? parseSharePointDriveIds(res.text) : [],
  };
}

/**
 * Repeat a drive id lookup in a throwaway config directory.
 *
 * The client checks for an outstanding resync before it runs anything at all,
 * this lookup included, and refuses to start until one is granted. Granting it
 * on the account's own directory is not an option: the same code path deletes
 * the item database, so asking for a drive id would cost that account a full
 * reconciliation.
 *
 * So the lookup runs somewhere else. The directory holds a copy of the refresh
 * token and nothing else, in particular no config file: with none present the
 * client computes no config hash, has nothing to compare against, and asks for
 * no resync at all. Passing --resync instead is not possible, the client
 * refuses it in combination with this lookup. The directory is removed again
 * afterwards.
 *
 * Microsoft rotates refresh tokens on use, so the token the lookup leaves
 * behind is copied back: the one the account still holds is spent, and without
 * this the next sign-in attempt would fail with no visible cause.
 *
 * @param {object} instance Signed-in instance used for the lookup.
 * @param {string} siteName Site name or URL, already validated.
 * @returns {Promise<{ok: boolean, text: string}|null>} Result, or null if there
 *   is no token to work with.
 */
async function lookupInScratchDir(instance, siteName) {
  const source = instanceConfDir(instance.id);
  const sourceToken = join(source, TOKEN_FILE);
  if (!existsSync(sourceToken)) return null;

  const scratch = `${source}.lookup`;
  const scratchToken = join(scratch, TOKEN_FILE);
  const scratchData = join(scratch, "data");

  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratchData, { recursive: true, mode: 0o700 });

  try {
    const before = readFileSync(sourceToken);
    writeFileSync(scratchToken, before, { mode: 0o600 });

    // Deliberately no config file in here, and no --resync either: the client
    // rejects --resync alongside this lookup outright, and without a config
    // file it never computes a config hash, so it has nothing to compare and
    // asks for no resync in the first place (config.d, createRequiredInitial
    // ConfigurationHashFiles). The syncdir is passed so the client cannot fall
    // back to a default path and create a directory nobody asked for.
    const res = await run(
      ["--confdir", scratch, "--syncdir", scratchData, "--get-sharepoint-drive-id", siteName],
      { timeout: REMOTE_TIMEOUT_MS }
    );

    if (existsSync(scratchToken)) {
      const after = readFileSync(scratchToken);
      if (!after.equals(before)) writeFileSync(sourceToken, after, { mode: 0o600 });
    }

    return res;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
