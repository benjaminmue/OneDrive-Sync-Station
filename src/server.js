#!/usr/bin/env node
// OneDrive Sync Station: process entry point.
//
// Owns everything that touches the container lifecycle: directory layout, the
// ADMIN_PASSWORD recovery path, starting the clients of enabled instances, and
// a shutdown that lets the clients close their databases. The HTTP layer itself
// lives in app.js.

import { createHash } from "node:crypto";
import { WEBUI_PORT, ensureDirs, loadSettings, saveSettings } from "./config.js";
import { hashPassword, destroyAllSessions } from "./auth.js";
import { createApp } from "./app.js";
import * as instances from "./instances.js";
import * as supervisor from "./supervisor.js";
import * as validate from "./validate.js";
import { log } from "./logger.js";

/**
 * Apply the ADMIN_PASSWORD environment variable when it is set and new.
 *
 * This is the documented way back in after a lost password: set the variable in
 * the container template, restart, sign in, then remove it again. A fingerprint
 * of the applied value is stored, so leaving the variable in place does not
 * silently overwrite a password the user has since changed in the UI on every
 * restart. It is still logged as a warning on every start, because a password
 * sitting in the container environment is readable through `docker inspect`.
 *
 * @returns {void}
 */
function applyPasswordOverride() {
  const override = process.env.ADMIN_PASSWORD;
  if (!override) return;

  // A salted hash would differ on every start, which is exactly what must not
  // happen here: the point is to recognise the same value again. This digest
  // never leaves the config volume and is not a credential on its own.
  const fingerprint = createHash("sha256").update(override).digest("hex");
  const settings = loadSettings();

  if (settings.adminPasswordFingerprint === fingerprint) {
    log.warn("ADMIN_PASSWORD is still set, remove it from the container configuration");
    return;
  }

  try {
    saveSettings({
      guiPasswordHash: hashPassword(validate.password(override)),
      adminPasswordFingerprint: fingerprint,
    });
    destroyAllSessions();
    log.warn("web ui password set from ADMIN_PASSWORD, unset the variable after signing in");
  } catch (err) {
    log.error("ADMIN_PASSWORD rejected", { reason: err.reason || err.message });
  }
}

/**
 * Start the clients of every instance that is signed in and set to auto start.
 * @returns {void}
 */
function startEnabledInstances() {
  for (const instance of instances.listInstances()) {
    if (!instance.autoStart) continue;
    if (!instances.isAuthenticated(instance)) {
      log.info("instance not signed in, not starting", { instance: instance.id });
      continue;
    }
    supervisor.start(instance);
  }
}

ensureDirs();

// A damaged state file makes both config.js and instances.js throw rather than
// quietly continue with defaults. Catching it here turns that into one readable
// line in the container log instead of an unhandled exception stack.
try {
  loadSettings();
  instances.listInstances();
} catch (err) {
  log.error("cannot start", { reason: err.message });
  process.exit(1);
}

applyPasswordOverride();

const app = await createApp();

let shuttingDown = false;

/**
 * Stop all clients, close the server, then exit. The clients get a SIGINT so
 * they close their item databases instead of dying with the container.
 *
 * Guarded against running twice: an orchestrator that sends SIGTERM and then
 * SIGINT would otherwise start two shutdowns and close the server twice.
 *
 * @param {string} signal The signal that triggered the shutdown.
 * @returns {Promise<void>} Resolves just before the process exits.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  await supervisor.stopAll();
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Last line of defence. Without these, one unexpected rejection anywhere takes
// the container down and every sync client with it; logging and carrying on is
// the better trade for a supervisor process.
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { reason: reason?.message || String(reason) });
});
process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { err: err?.message || String(err) });
});

await app.listen({ port: WEBUI_PORT, host: "0.0.0.0" });
log.info("station started", { port: WEBUI_PORT });
startEnabledInstances();
