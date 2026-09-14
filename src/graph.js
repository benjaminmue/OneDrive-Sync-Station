// The folder tree of an account, read straight from Microsoft Graph.
//
// The alternative is a dry run of the sync client, which fetches the same
// /delta pages and then walks every single file as if it were downloading it.
// On a personal account with a few thousand photos that took more than a
// quarter of an hour for what is, in the end, a list of folder names (#3).
//
// Graph needs an access token, and the only credential the station has is the
// client's refresh token. It is redeemed here in memory and the new refresh
// token Microsoft returns is thrown away: the client's token file is never
// written. That is safe because the identity platform does not revoke a
// refresh token when it is redeemed ("The Microsoft identity platform doesn't
// revoke old refresh tokens when used to fetch new access tokens",
// learn.microsoft.com/entra/identity-platform/refresh-tokens), so the client
// keeps working with the token it has, whether it is running or not.

import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { refreshTokenPath } from "./instances.js";

/** The client's own application registration, used unless the account names another. */
export const DEFAULT_APPLICATION_ID = "d50ca740-c83f-4d1b-b616-12c519384f0c";

// Only the global cloud: the station has no setting for national clouds, and
// sending a token for them to the global endpoints would simply fail. The test
// suite points these at a local stub, which a production container never can.
const testing = process.env.NODE_ENV !== "production";
const LOGIN_BASE = (testing && process.env.GRAPH_LOGIN_BASE) || "https://login.microsoftonline.com";
const GRAPH_BASE = (testing && process.env.GRAPH_API_BASE) || "https://graph.microsoft.com/v1.0";
/** Tests that exercise the dry run switch Graph off, so no socket is even tried. */
const DISABLED = testing && process.env.GRAPH_API_BASE === "off";

// Every request has its own timeout; there is no limit on the listing as a
// whole, because a large library legitimately takes many pages and giving up
// would hand it to the much slower dry run.
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 4;
const MAX_RETRY_WAIT_S = 60;
/** Answers worth another attempt: throttling and transient server trouble. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
/** Generous for any real account, and a stop for a server that never ends its paging. */
const MAX_PAGES = 20_000;
/** Deeper chains than this are treated as a loop in the parent references. */
const MAX_DEPTH = 256;

/** A Graph or token failure, with a reason safe to log and show. */
export class GraphError extends Error {
  /**
   * @param {string} reason Short machine-readable cause.
   * @param {string} [detail] Human-readable detail, never containing a token.
   */
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

/**
 * Wait before a retry, unless the run is cancelled first.
 * @param {number} ms Milliseconds.
 * @param {AbortSignal} [signal] Cancels the wait.
 * @returns {Promise<void>}
 * @throws {GraphError} When cancelled.
 */
async function backOff(ms, signal) {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    throw new GraphError("cancelled");
  }
}

/**
 * Fetch with a timeout, retrying throttling, transient server errors and
 * dropped connections.
 * @param {string} url Request URL.
 * @param {RequestInit} init Request options.
 * @param {AbortSignal} [signal] Cancels the whole run.
 * @returns {Promise<Response>} The first answer that is not worth retrying.
 * @throws {GraphError} When cancelled or when the network keeps failing.
 */
async function request(url, init, signal) {
  for (let attempt = 0; ; attempt += 1) {
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
    } catch (err) {
      if (signal?.aborted) throw new GraphError("cancelled");
      // fetch reports the actual cause (DNS, refused, TLS) only on err.cause.
      if (attempt >= MAX_RETRIES) {
        throw new GraphError("network", err.cause?.code || err.cause?.message || err.name);
      }
      await backOff(2 ** attempt * 1000, signal);
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= MAX_RETRIES) return res;
    // Retry-After may legitimately be 0; only a missing or non-numeric value
    // falls back to backing off.
    const header = res.headers.get("retry-after");
    const asked = header === null || header.trim() === "" ? NaN : Number(header);
    const wait = Math.min(Number.isFinite(asked) ? asked : 2 ** attempt, MAX_RETRY_WAIT_S);
    await res.body?.cancel();
    await backOff(wait * 1000, signal);
  }
}

/**
 * Redeem the account's refresh token for an access token.
 *
 * The token file is read, never written: the refresh token in the response is
 * discarded on purpose, see the header of this module.
 * @param {object} instance Instance record.
 * @param {AbortSignal} [signal] Cancels the request.
 * @returns {Promise<string>} An access token, only ever held in memory.
 * @throws {GraphError} When there is no token or Microsoft refuses it.
 */
export async function accessToken(instance, signal) {
  let refreshToken;
  try {
    refreshToken = readFileSync(refreshTokenPath(instance), "utf8").trim();
  } catch {
    throw new GraphError("not-authenticated");
  }
  if (!refreshToken) throw new GraphError("not-authenticated");

  // Exactly the request the client makes when it refreshes (onedrive.d,
  // newToken): no scope, so the token covers what was consented at sign-in,
  // and the client's redirect URI. That request demonstrably works for
  // personal, business and SharePoint accounts; asking for scopes explicitly,
  // such as SharePoint's on a personal account, is a way to be refused.
  const tenant = instance.options?.azureTenantId || "common";
  const clientId = instance.options?.applicationId || DEFAULT_APPLICATION_ID;
  // The default registration always uses the common native-client URI; a
  // custom registration uses its tenant's, as the client does.
  const redirectTenant = clientId === DEFAULT_APPLICATION_ID ? "common" : encodeURIComponent(tenant);
  const body = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${LOGIN_BASE}/${redirectTenant}/oauth2/nativeclient`,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await request(
    `${LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
    signal
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.access_token !== "string") {
    // Only the error code: the description can quote the request.
    throw new GraphError("token-refused", typeof data.error === "string" ? data.error : `http ${res.status}`);
  }
  return data.access_token;
}

/**
 * Where the delta enumeration of an account starts.
 * @param {object} instance Instance record.
 * @returns {string} Absolute URL of the first page.
 * @throws {GraphError} For a SharePoint account without a drive id.
 */
function deltaUrl(instance) {
  // A library without its drive id must not quietly list the signed-in user's
  // own drive instead, and have that stored as the library's complete list.
  if (instance.type === "sharepoint" && !instance.driveId) throw new GraphError("no-drive-id");
  const drive = instance.type === "sharepoint" ? `/drives/${encodeURIComponent(instance.driveId)}` : "/me/drive";
  const query = new URLSearchParams({
    $select: "id,name,folder,remoteItem,parentReference,deleted,root",
    $top: "999",
  });
  return `${GRAPH_BASE}${drive}/root/delta?${query}`;
}

/**
 * @typedef {object} TreeItem
 * @property {string} id Item id.
 * @property {string} name Item name.
 * @property {string|undefined} parentId Id of the parent item.
 * @property {boolean} root Whether this is the drive root.
 * @property {boolean} remote Whether this is a folder shared in from another drive.
 */

/**
 * Reduce a delta item to what the tree needs, or null for anything that is not
 * a folder. Files are most of a drive; keeping them would hold the whole
 * account in memory to produce a list of folder names.
 * @param {object} item A delta item as Graph returns it.
 * @returns {TreeItem|null} The slim item, or null.
 */
export function treeItem(item) {
  const root = Boolean(item.root);
  const remote = Boolean(item.remoteItem?.folder);
  if (!root && !remote && !item.folder) return null;
  return { id: item.id, name: String(item.name ?? ""), parentId: item.parentReference?.id, root, remote };
}

/**
 * Turn the folder items into paths.
 *
 * Delta carries no paths, only parent ids, so each path is assembled by
 * walking up to the root; paths already known on the way are reused. Folders
 * shared into the account appear as remote items. They are listed so they can
 * be selected, but their contents live on another drive and are not in this
 * listing, which the caller needs to know: see `remote`.
 * @param {Map<string, TreeItem>} items Current folder items by id.
 * @returns {{folders: string[], remote: string[]}} Relative folder paths, e.g. "Bilder/Paris", and the shared folders among them.
 */
export function folderPaths(items) {
  /** @type {Map<string, string|null>} */
  const resolved = new Map();

  /**
   * @param {TreeItem} item A folder item.
   * @returns {string|null} Its path, or null when it hangs off nothing usable.
   */
  const pathOf = (item) => {
    const chain = [];
    let current = item;
    let prefix = null;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      if (resolved.has(current.id)) {
        prefix = resolved.get(current.id);
        break;
      }
      if (current.root) {
        prefix = "";
        break;
      }
      if (!current.name) break;
      chain.push(current);
      const parent = items.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    // Unresolvable (orphan, loop, nameless): remember that for the whole chain.
    let path = prefix;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      path = path === null ? null : path ? `${path}/${chain[i].name}` : chain[i].name;
      resolved.set(chain[i].id, path);
    }
    return path;
  };

  const folders = [];
  const remote = [];
  for (const item of items.values()) {
    if (item.root) continue;
    const path = pathOf(item);
    if (!path) continue;
    folders.push(path);
    if (item.remote) remote.push(path);
  }
  const byName = (a, b) => a.localeCompare(b);
  return { folders: folders.sort(byName), remote: remote.sort(byName) };
}

/**
 * Read every folder of an account from Graph.
 * @param {object} instance Instance record.
 * @param {{signal?: AbortSignal}} [opts] Cancellation.
 * @returns {Promise<{folders: string[], remote: string[], items: number, pages: number}>}
 *   Relative folder paths, the shared folders whose contents are not included,
 *   and what it took.
 * @throws {GraphError} On any failure; the caller falls back to the client.
 */
export async function listFolders(instance, opts = {}) {
  if (DISABLED) throw new GraphError("disabled");
  const { signal } = opts;
  let token = await accessToken(instance, signal);
  /** @type {Map<string, TreeItem>} */
  const items = new Map();
  let url = deltaUrl(instance);
  let pages = 0;
  let renewed = false;

  while (url) {
    // The next page comes from the response. Anything that would carry the
    // token to another host is refused rather than followed.
    if (!url.startsWith(`${GRAPH_BASE}/`)) throw new GraphError("unexpected-link");
    if (++pages > MAX_PAGES) throw new GraphError("too-many-pages");

    const res = await request(url, { headers: { authorization: `Bearer ${token}` } }, signal);
    // An access token lasts about an hour; a very large drive can outlast it.
    // One renewal per expiry, so a token that is refused outright still ends it.
    if (res.status === 401 && !renewed) {
      await res.body?.cancel();
      token = await accessToken(instance, signal);
      renewed = true;
      pages -= 1;
      continue;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !Array.isArray(data.value)) {
      throw new GraphError("delta-failed", data?.error?.code || `http ${res.status}`);
    }
    renewed = false;
    // The same item can appear more than once; the last occurrence is its
    // current state, including being deleted.
    for (const raw of data.value) {
      if (!raw || typeof raw.id !== "string") continue;
      const item = raw.deleted ? null : treeItem(raw);
      if (item) items.set(raw.id, item);
      else items.delete(raw.id);
    }
    url = typeof data["@odata.nextLink"] === "string" ? data["@odata.nextLink"] : null;
  }

  // Without the root nothing can be placed, and an empty result stored as a
  // complete listing would mark every local folder as existing only here.
  if (![...items.values()].some((item) => item.root)) throw new GraphError("no-root");

  let { folders, remote } = folderPaths(items);
  // Match the client: with skip_dotfiles it ignores these, so offering them for
  // selection would only produce rules that never sync anything.
  if (instance.options?.skipDotfiles) {
    const visible = (path) => !path.split("/").some((segment) => segment.startsWith("."));
    folders = folders.filter(visible);
    remote = remote.filter(visible);
  }
  return { folders, remote, items: items.size, pages };
}
