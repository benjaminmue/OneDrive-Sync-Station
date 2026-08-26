// Sync instance registry.
//
// One instance is one running onedrive client: its own config directory
// (--confdir), its own local folder below DATA_DIR (--syncdir) and its own
// Microsoft sign-in. A OneDrive Personal account, a Business account and each
// SharePoint document library are separate instances, exactly as the upstream
// client expects.
//
// The registry file holds only what the station itself needs. Everything the
// client reads is rendered into its config directory from these values, so the
// registry stays the single source of truth and the client config can always be
// rebuilt from it.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR,
  instanceConfDir,
  instanceDataDir,
} from "./config.js";
import { writeFileAtomic, readJsonFile } from "./storage.js";
import * as validate from "./validate.js";
import { ValidationError } from "./validate.js";

const REGISTRY_FILE = join(CONFIG_DIR, "instances.json");

/** Name of the client file that proves an instance completed its sign-in. */
const REFRESH_TOKEN_FILE = "refresh_token";

/** Default sync options applied to a new instance. */
const DEFAULT_OPTIONS = {
  downloadOnly: false,
  uploadOnly: false,
  monitorInterval: 300, // seconds; the client enforces a 300 s minimum
  skipDotfiles: false,
  skipSymlinks: false,
  syncBusinessSharedItems: false,
  skipFile: "~*|.~*|*.tmp|*.swp|*.partial", // upstream default
  skipDir: "",
  rateLimit: 0, // bytes per second per thread, 0 = unlimited
  threads: 8, // upstream default, max 16
  applicationId: "", // empty = upstream default public client application
  azureTenantId: "", // empty = common endpoint
  useDeviceAuth: false, // sign in with a device code instead of pasting a URL
};

let cache = null;

/**
 * Read the registry from disk.
 *
 * A missing file is a fresh install. A corrupt one is refused rather than
 * treated as empty: an empty registry looks like "no accounts configured", so
 * the user would create them again while the old config directories, sign-ins
 * and item databases stay behind unreferenced.
 *
 * @returns {{instances: object[]}} The registry contents.
 * @throws {Error} When the registry exists but cannot be parsed.
 */
function loadRegistry() {
  if (cache) return cache;
  const result = readJsonFile(REGISTRY_FILE);
  if (result.status === "corrupt") {
    throw new Error(
      `${REGISTRY_FILE} exists but is not valid JSON (${result.error.message}). ` +
        "Refusing to continue with an empty account list. Restore the file from a " +
        "backup, or delete it to start over (the synced data is not affected)."
    );
  }
  const stored = result.status === "ok" && Array.isArray(result.data?.instances)
    ? result.data
    : { instances: [] };
  cache = stored;
  return cache;
}

/**
 * Persist the registry.
 * @param {{instances: object[]}} registry Registry to write.
 * @returns {void}
 */
function saveRegistry(registry) {
  cache = registry;
  writeFileAtomic(REGISTRY_FILE, JSON.stringify(registry, null, 2), { mode: 0o600 });
}

/**
 * Validate and normalise a partial set of sync options.
 * @param {object} raw Untrusted option values.
 * @param {object} [base] Options to merge onto (defaults for new instances).
 * @returns {object} Normalised options.
 * @throws {ValidationError} On any invalid value.
 */
export function normaliseOptions(raw = {}, base = DEFAULT_OPTIONS) {
  const has = (key) => Object.prototype.hasOwnProperty.call(raw, key);
  const next = { ...base };

  if (has("downloadOnly")) next.downloadOnly = validate.boolean(raw.downloadOnly);
  if (has("uploadOnly")) next.uploadOnly = validate.boolean(raw.uploadOnly);
  if (has("useDeviceAuth")) next.useDeviceAuth = validate.boolean(raw.useDeviceAuth);
  if (has("skipDotfiles")) next.skipDotfiles = validate.boolean(raw.skipDotfiles);
  if (has("skipSymlinks")) next.skipSymlinks = validate.boolean(raw.skipSymlinks);
  if (has("syncBusinessSharedItems")) {
    next.syncBusinessSharedItems = validate.boolean(raw.syncBusinessSharedItems);
  }
  if (has("monitorInterval")) {
    next.monitorInterval = validate.integer(raw.monitorInterval, {
      field: "monitorInterval",
      min: 300, // below this the client clamps anyway
      max: 86400,
    });
  }
  if (has("rateLimit")) {
    next.rateLimit = validate.integer(raw.rateLimit, {
      field: "rateLimit",
      min: 0,
      max: 1_000_000_000,
    });
  }
  if (has("threads")) {
    next.threads = validate.integer(raw.threads, { field: "threads", min: 1, max: 16 });
  }
  if (has("skipFile")) next.skipFile = validate.configValue(raw.skipFile, "skipFile");
  if (has("skipDir")) next.skipDir = validate.configValue(raw.skipDir, "skipDir");
  if (has("applicationId")) {
    const value = String(raw.applicationId ?? "").trim();
    // Empty keeps the upstream default application; otherwise it must be a GUID.
    if (value && !/^[0-9a-fA-F-]{36}$/.test(value)) {
      throw new ValidationError("applicationId", "not-a-guid");
    }
    next.applicationId = value;
  }
  if (has("azureTenantId")) {
    const value = String(raw.azureTenantId ?? "").trim();
    // Either a GUID or a verified domain such as contoso.onmicrosoft.com.
    if (value && !/^[0-9a-zA-Z.-]{1,128}$/.test(value)) {
      throw new ValidationError("azureTenantId", "invalid-characters");
    }
    next.azureTenantId = value;
  }

  // The client rejects this combination; catching it here keeps the error in
  // the form instead of in a log line the user has to go looking for.
  if (next.downloadOnly && next.uploadOnly) {
    throw new ValidationError("uploadOnly", "conflicts-with-download-only");
  }
  return next;
}

/**
 * All registered instances.
 * @returns {object[]} A shallow copy of the instance list.
 */
export function listInstances() {
  return loadRegistry().instances.slice();
}

/**
 * Look up one instance.
 * @param {string} id Instance id.
 * @returns {object|null} The instance, or null when unknown.
 */
export function getInstance(id) {
  return loadRegistry().instances.find((item) => item.id === id) || null;
}

/**
 * Look up one instance or throw, for routes that require it to exist.
 * @param {string} id Instance id.
 * @returns {object} The instance.
 * @throws {ValidationError} When the id is unknown.
 */
export function requireInstance(id) {
  const instance = getInstance(validate.slug(id));
  if (!instance) throw new ValidationError("id", "unknown-instance");
  return instance;
}

/**
 * Whether an instance has completed its Microsoft sign-in. The client writes a
 * refresh token into its config directory once authorisation succeeded, so the
 * presence of that file is the authoritative answer.
 * @param {object} instance Instance record.
 * @returns {boolean} True when a refresh token exists.
 */
export function isAuthenticated(instance) {
  return existsSync(join(instanceConfDir(instance.id), REFRESH_TOKEN_FILE));
}

/**
 * Path of the refresh token file of an instance.
 * @param {object} instance Instance record.
 * @returns {string} Absolute path.
 */
export function refreshTokenPath(instance) {
  return join(instanceConfDir(instance.id), REFRESH_TOKEN_FILE);
}

/**
 * Register a new instance and lay out its directories.
 * @param {{name: string, type: string, folder?: string, driveId?: string, autoStart?: unknown, options?: object}} input Untrusted input.
 * @returns {object} The created instance record.
 * @throws {ValidationError} On invalid input or a name collision.
 */
export function createInstance(input) {
  const name = validate.displayName(input.name);
  const type = validate.accountType(input.type);

  // The id doubles as the config directory name, the folder as the data
  // directory name. Both derive from the display name unless given explicitly,
  // so the common case needs no extra input.
  const id = validate.slug(input.id || validate.slugify(name) || "instance", "id");
  const folder = validate.slug(input.folder || id, "folder");

  const registry = loadRegistry();
  if (registry.instances.some((item) => item.id === id)) {
    throw new ValidationError("id", "already-exists");
  }
  if (registry.instances.some((item) => item.folder === folder)) {
    throw new ValidationError("folder", "already-exists");
  }

  // A SharePoint library is addressed by its drive id; personal and business
  // accounts sync their default drive and must not carry one.
  let driveId = null;
  if (type === "sharepoint") {
    if (!input.driveId) throw new ValidationError("driveId", "required-for-sharepoint");
    driveId = validate.driveId(input.driveId);
  }

  const now = new Date().toISOString();
  const instance = {
    id,
    name,
    type,
    folder,
    driveId,
    autoStart: input.autoStart === undefined ? true : validate.boolean(input.autoStart),
    // Syncing does not begin on its own until the user has decided what to
    // sync. Starting right after the sign-in would download the entire account
    // before the folder selection is even visible, which on a large account
    // means gigabytes of the wrong data.
    setupComplete: false,
    options: normaliseOptions(input.options || {}),
    createdAt: now,
    updatedAt: now,
  };

  // 0700 on the config directory: the client writes its refresh token and its
  // item database (a full listing of every file in the account) in here, under
  // the container's umask, which on Unraid is deliberately group-writable for
  // the data share. That default must not reach this directory.
  mkdirSync(instanceConfDir(id), { recursive: true, mode: 0o700 });
  mkdirSync(instanceDataDir(folder), { recursive: true });
  writeClientConfig(instance);

  registry.instances.push(instance);
  saveRegistry(registry);
  return instance;
}

/**
 * Update mutable fields of an instance and re-render its client config.
 * The id and the data folder are immutable: both are directory names that the
 * client database and the synced files already refer to, so changing them would
 * silently orphan data.
 * @param {string} id Instance id.
 * @param {object} patch Untrusted patch.
 * @returns {object} The updated instance record.
 * @throws {ValidationError} On invalid input.
 */
export function updateInstance(id, patch) {
  const registry = loadRegistry();
  const index = registry.instances.findIndex((item) => item.id === validate.slug(id));
  if (index === -1) throw new ValidationError("id", "unknown-instance");

  const current = registry.instances[index];
  const next = { ...current };

  if (patch.name !== undefined) next.name = validate.displayName(patch.name);
  if (patch.autoStart !== undefined) next.autoStart = validate.boolean(patch.autoStart);
  if (patch.setupComplete !== undefined) next.setupComplete = validate.boolean(patch.setupComplete);
  if (patch.driveId !== undefined && current.type === "sharepoint") {
    next.driveId = validate.driveId(patch.driveId);
  }
  if (patch.options !== undefined) {
    next.options = normaliseOptions(patch.options, current.options);
  }
  next.updatedAt = new Date().toISOString();

  writeClientConfig(next);
  registry.instances[index] = next;
  saveRegistry(registry);
  return next;
}

/**
 * Remove an instance from the registry and delete its config directory. Synced
 * files are kept unless explicitly requested, so a mis-click cannot wipe data
 * that only exists locally.
 * @param {string} id Instance id.
 * @param {{deleteData?: boolean}} [opts] Whether to delete the data folder too.
 * @returns {void}
 * @throws {ValidationError} When the id is unknown.
 */
export function deleteInstance(id, opts = {}) {
  const registry = loadRegistry();
  const index = registry.instances.findIndex((item) => item.id === validate.slug(id));
  if (index === -1) throw new ValidationError("id", "unknown-instance");

  const instance = registry.instances[index];
  rmSync(instanceConfDir(instance.id), { recursive: true, force: true });
  if (opts.deleteData) {
    rmSync(instanceDataDir(instance.folder), { recursive: true, force: true });
  }

  registry.instances.splice(index, 1);
  saveRegistry(registry);
}

/**
 * Render the onedrive client config file for an instance.
 *
 * sync_dir and the config directory are deliberately NOT written here: both are
 * passed on the command line on every invocation, which is what the upstream
 * container does as well. Keeping them out of the file removes any chance of
 * the file and the arguments disagreeing about where data lives.
 *
 * @param {object} instance Instance record.
 * @returns {string} The rendered config file contents.
 */
export function writeClientConfig(instance) {
  const o = instance.options;
  /** @type {Array<[string, string|number|boolean]>} */
  const entries = [
    ["monitor_interval", o.monitorInterval],
    ["skip_file", o.skipFile],
    ["skip_dir", o.skipDir],
    ["skip_dotfiles", o.skipDotfiles],
    ["skip_symlinks", o.skipSymlinks],
    ["download_only", o.downloadOnly],
    ["upload_only", o.uploadOnly],
    ["sync_business_shared_items", o.syncBusinessSharedItems],
    ["rate_limit", o.rateLimit],
    ["threads", o.threads],
  ];
  // Only written when enabled: the key changes which authorisation flow the
  // client uses, and leaving it at "false" in the file is the same as absent
  // while making every config file churn when the default changes.
  if (o.useDeviceAuth) entries.push(["use_device_auth", true]);
  if (instance.driveId) entries.push(["drive_id", instance.driveId]);
  if (o.applicationId) entries.push(["application_id", o.applicationId]);
  if (o.azureTenantId) entries.push(["azure_tenant_id", o.azureTenantId]);

  // Every value passed validate.configValue on the way in, so no value can
  // contain a quote or a newline and break out of this form.
  const body = entries
    .map(([key, value]) => `${key} = "${typeof value === "boolean" ? String(value) : value}"`)
    .join("\n");

  const contents =
    "# Generated by OneDrive Sync Station. Manual edits are overwritten.\n" +
    `# Instance: ${instance.id}\n` +
    body +
    "\n";

  const dir = instanceConfDir(instance.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dir, "config"), contents, { mode: 0o600 });
  return contents;
}

/**
 * Public view of an instance for the API, enriched with live state that is not
 * part of the stored record.
 * @param {object} instance Instance record.
 * @returns {object} The instance plus its authentication state and paths.
 */
export function describeInstance(instance) {
  return {
    ...instance,
    authenticated: isAuthenticated(instance),
    dataPath: instanceDataDir(instance.folder),
    confPath: instanceConfDir(instance.id),
  };
}
