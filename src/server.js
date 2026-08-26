#!/usr/bin/env node
// OneDrive Sync Station: process entry point.
//
// Owns everything that touches the container lifecycle: directory layout, the
// ADMIN_PASSWORD recovery path, starting the clients of enabled instances, and
// a shutdown that lets the clients close their databases. The HTTP layer itself
// lives in app.js.

import { WEBUI_PORT, ensureDirs, saveSettings } from "./config.js";
import { hashPassword, destroyAllSessions } from "./auth.js";
import { createApp } from "./app.js";
import * as instances from "./instances.js";
import * as supervisor from "./supervisor.js";
import * as validate from "./validate.js";
import { log } from "./logger.js";

/**
 * Apply the ADMIN_PASSWORD environment variable when it is set.
 *
 * This is the documented way back in after a lost password: set the variable in
 * the container template, restart, sign in, then remove it again. Existing
 * sessions are dropped so an old browser session cannot outlive the change.
 * @returns {void}
 */
function applyPasswordOverride() {
  const override = process.env.ADMIN_PASSWORD;
  if (!override) return;
  try {
    saveSettings({ guiPasswordHash: hashPassword(validate.password(override)) });
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
applyPasswordOverride();

const app = await createApp();

/**
 * Stop all clients, close the server, then exit. The clients get a SIGINT so
 * they close their item databases instead of dying with the container.
 * @param {string} signal The signal that triggered the shutdown.
 * @returns {Promise<void>} Resolves just before the process exits.
 */
async function shutdown(signal) {
  log.info("shutting down", { signal });
  await supervisor.stopAll();
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await app.listen({ port: WEBUI_PORT, host: "0.0.0.0" });
log.info("station started", { port: WEBUI_PORT });
startEnabledInstances();
