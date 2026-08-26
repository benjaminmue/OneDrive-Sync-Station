// The client's "a resync is required" exit.
//
// Found on the first real run against a Microsoft account: after a sign-in, and
// after any change to its configuration file, the client refuses to start and
// exits with EXIT_RESYNC_REQUIRED (126). Treating that as a crash puts a
// perfectly healthy account into an ever-growing restart backoff and shows it as
// failing, which is exactly what happened. The answer is to grant the resync
// once and start again.
//
// Its own file because the stub client is steered through the environment,
// which is fixed when the modules are first imported.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let instance;

before(async () => {
  process.env.FAKE_DEMAND_RESYNC = "1";
  env = await bootstrap();
  instance = env.instances.createInstance({ name: "Fresh Signin", type: "personal" });
  writeFileSync(env.instances.refreshTokenPath(instance), "test-token\n");
});

after(async () => {
  await env.supervisor.stopAll();
  delete process.env.FAKE_DEMAND_RESYNC;
  env.cleanup();
});

/**
 * Whether any buffered log line of the instance contains a fragment.
 * @param {string} fragment Text to look for.
 * @returns {boolean} True when present.
 */
function logHas(fragment) {
  return env.supervisor.logs(instance.id).some((entry) => entry.line.includes(fragment));
}

test("a client demanding a resync is restarted with one instead of backed off", async () => {
  env.supervisor.start(instance);

  // Waiting on `running` alone would prove nothing: the flag is already set the
  // moment the first process is spawned, before it exits with its demand.
  const recovered = await waitFor(() => logHas("requires a resync"), 15_000);
  assert.ok(recovered, "the demand was recognised rather than treated as a crash");

  const resynced = await waitFor(() => logHas("Performing a database resync"), 15_000);
  assert.ok(resynced, "the restart actually carried --resync to the client");

  const up = await waitFor(() => logHas("Starting monitor mode"), 15_000);
  assert.ok(up, "the account ends up syncing rather than stuck");
  assert.equal(env.supervisor.status(instance.id).running, true);
});

test("the demand does not count as a crash", () => {
  const status = env.supervisor.status(instance.id);
  // Counting it would grow the delay on every configuration change until the
  // account sits idle for five minutes after a simple settings edit.
  assert.equal(status.failures, 0);
  assert.equal(status.running, true);
});
