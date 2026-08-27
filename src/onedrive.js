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
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { instanceConfDir, instanceDataDir } from "./config.js";
import { writeFileAtomic } from "./storage.js";
import { log } from "./logger.js";

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

/** Accounts with a scratch lookup in flight, so a second one cannot collide. */
const scratchLookups = new Set();

/** Makes each scratch directory name unique within this process. */
let scratchCounter = 0;

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

/** Cached `--version` promise; the version can only change with the image. */
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
  // The promise is cached, not its result: caching the result meant every
  // request arriving during the first call still saw null and spawned its own
  // client. That route needs no session, so a burst at startup could exhaust
  // the container's process limit from outside.
  if (!versionCache) versionCache = run(["--version"]);
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
 * Query the drive ids of the SharePoint libraries of a site.
 *
 * Requires an instance that is already signed in with an account that can see
 * the site: the lookup runs as that account.
 *
 * @param {object} instance Signed-in instance used for the lookup.
 * @param {string} site Site name, already reduced and validated in validate.js.
 * @returns {Promise<{ok: boolean, text: string, libraries: Array<{name: string, driveId: string}>}>} Result.
 */
export async function getSharePointDriveId(instance, site) {
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
 * @param {string} site Site name, already validated.
 * @returns {Promise<{ok: boolean, text: string}|null>} Result, or null if there
 *   is no token to work with.
 */
async function lookupInScratchDir(instance, site) {
  const source = instanceConfDir(instance.id);
  const sourceToken = join(source, TOKEN_FILE);
  if (!existsSync(sourceToken)) return null;

  // One lookup per account at a time. The scratch directory is derived from the
  // account, so a second concurrent lookup would delete the first one's
  // directory out from under its running client and could write back the wrong
  // token.
  if (scratchLookups.has(instance.id)) return { ok: false, text: "lookup-already-running" };
  scratchLookups.add(instance.id);

  // Unique per run, so a directory left behind by a killed container is never
  // mistaken for this run's, and cleanup never removes someone else's.
  const scratch = `${source}.lookup-${process.pid}-${++scratchCounter}`;
  const scratchToken = join(scratch, TOKEN_FILE);
  const scratchData = join(scratch, "data");

  try {
    mkdirSync(scratchData, { recursive: true, mode: 0o700 });

    const before = readFileSync(sourceToken);
    writeFileSync(scratchToken, before, { mode: 0o600 });

    // Deliberately no config file in here, and no --resync either: the client
    // rejects --resync alongside this lookup outright, and without a config
    // file it never computes a config hash, so it has nothing to compare and
    // asks for no resync in the first place (config.d, createRequiredInitial
    // ConfigurationHashFiles). The syncdir is passed so the client cannot fall
    // back to a default path and create a directory nobody asked for.
    const res = await run(
      ["--confdir", scratch, "--syncdir", scratchData, "--get-sharepoint-drive-id", site],
      { timeout: REMOTE_TIMEOUT_MS }
    );

    // Written back only if the source still holds exactly what was copied. If it
    // changed meanwhile, the account's own client rotated its token during the
    // lookup and that one is newer: overwriting it would leave the account
    // holding a token Microsoft has already superseded. Written atomically, so
    // a crash mid-write cannot leave a truncated token behind.
    if (existsSync(scratchToken)) {
      const after = readFileSync(scratchToken);
      if (!after.equals(before)) {
        if (readFileSync(sourceToken).equals(before)) {
          writeFileAtomic(sourceToken, after, { mode: 0o600 });
        } else {
          log.warn("token rotated during a lookup, keeping the account's own", {
            instance: instance.id,
          });
        }
      }
    }

    if (!res.ok) {
      // The directory is created empty and holds one file this code put there,
      // so a refusal blaming a changed configuration is about something the
      // client brought along itself. Listing what is in there is the only way
      // to tell which, and it is gone a moment later.
      const contents = readdirSync(scratch).sort().join(", ") || "(empty)";
      return { ...res, text: `${res.text}

[station] isolated run, directory held: ${contents}` };
    }

    return res;
  } finally {
    // Covers a failure during setup as well, and never throws: a cleanup error
    // must not replace the result the caller is waiting for.
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch (err) {
      log.warn("could not remove the lookup directory", { dir: scratch, err: err.message });
    }
    scratchLookups.delete(instance.id);
  }
}
