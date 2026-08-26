// Test bootstrap.
//
// The station reads its paths from the environment when config.js is first
// imported, so every test file points them at a fresh temporary directory
// BEFORE importing anything from src/. node --test runs each file in its own
// process, so the modules stay isolated per file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the stub client used instead of the real binary. */
export const FAKE_CLIENT = fileURLToPath(new URL("./fixtures/fake-onedrive.mjs", import.meta.url));

/**
 * Point the station at a fresh temporary environment and load its modules.
 * @param {{clientBin?: string}} [opts] Override the client binary, for example
 *   with a path that cannot be executed, to exercise spawn failures.
 * @returns {Promise<{root: string, cleanup: () => void, config: object, instances: object, supervisor: object, onedrive: object, authflow: object, synclist: object, validate: object}>} Loaded modules and the temp root.
 */
export async function bootstrap(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "odss-test-"));
  process.env.CONFIG_DIR = join(root, "config");
  process.env.DATA_DIR = join(root, "data");
  process.env.ONEDRIVE_BIN = opts.clientBin ?? FAKE_CLIENT;

  const config = await import("../src/config.js");
  config.ensureDirs();

  return {
    root,
    config,
    instances: await import("../src/instances.js"),
    supervisor: await import("../src/supervisor.js"),
    onedrive: await import("../src/onedrive.js"),
    authflow: await import("../src/authflow.js"),
    synclist: await import("../src/synclist.js"),
    validate: await import("../src/validate.js"),
    /** Remove the temporary directory. Retries because Windows may still hold handles. */
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/**
 * Wait until a condition holds or the timeout expires.
 * @param {() => boolean} predicate Condition to poll.
 * @param {number} [timeoutMs] Maximum wait.
 * @returns {Promise<boolean>} True when the condition became true in time.
 */
export async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
