// Paths and station level settings.
//
// Two volumes, deliberately separate:
//   CONFIG_DIR (/config) - everything the station remembers: its own settings,
//                          the instance registry and one onedrive client config
//                          directory per instance (client config, sync_list,
//                          refresh token, item database).
//   DATA_DIR   (/data)   - synced files only. One subdirectory per instance, so
//                          the shares stay browsable without any station
//                          metadata mixed in.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
export const DATA_DIR = process.env.DATA_DIR || "/data";

/** Parent of all per-instance onedrive client config directories. */
export const INSTANCES_DIR = join(CONFIG_DIR, "instances");

/** Scratch directory for the file based authentication handshake. */
export const AUTH_DIR = join(CONFIG_DIR, "auth");

export const WEBUI_PORT = Number(process.env.WEBUI_PORT || 8080);

const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

const DEFAULTS = {
  guiPasswordHash: null, // scrypt hash; null means first-run setup is pending
  cookieSecret: null, // generated once, then persisted
};

let cache = null;

/**
 * Create the directory layout both volumes need. Safe to call repeatedly.
 * @returns {void}
 */
export function ensureDirs() {
  for (const dir of [CONFIG_DIR, INSTANCES_DIR, AUTH_DIR, DATA_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load station settings, falling back to defaults when the file is missing or
 * corrupt. Corrupt settings must not brick the station: the user can then set a
 * new password through the first-run screen.
 * @returns {object} The effective settings.
 */
export function loadSettings() {
  if (cache) return cache;
  let stored = {};
  if (existsSync(SETTINGS_FILE)) {
    try {
      stored = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    } catch {
      stored = {};
    }
  }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

/**
 * Merge a patch into the station settings and persist them.
 * @param {object} patch Keys to overwrite.
 * @returns {object} The new settings.
 */
export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  cache = next;
  // 0600: the file holds the GUI password hash and the cookie secret.
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

/**
 * Join a validated path segment onto a base directory and prove the result
 * stays inside it. The segments are already slug-validated everywhere we call
 * this, so it is a second line of defence rather than the only one.
 * @param {string} base Absolute base directory.
 * @param {string} segment Single path segment.
 * @returns {string} The absolute path inside base.
 * @throws {Error} If the resolved path would escape the base directory.
 */
export function safeJoin(base, segment) {
  const target = resolve(base, segment);
  const root = resolve(base);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`path escapes base directory: ${segment}`);
  }
  return target;
}

/**
 * Absolute onedrive client config directory of an instance (`--confdir`).
 * @param {string} id Validated instance id.
 * @returns {string} Absolute path.
 */
export function instanceConfDir(id) {
  return safeJoin(INSTANCES_DIR, id);
}

/**
 * Absolute local sync directory of an instance (`--syncdir`).
 * @param {string} folder Validated data folder name.
 * @returns {string} Absolute path.
 */
export function instanceDataDir(folder) {
  return safeJoin(DATA_DIR, folder);
}
