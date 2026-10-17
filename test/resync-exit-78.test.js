// The resync demand as client v2.5.12 reports it.
//
// Up to v2.5.11 the client exits with 126 when it requires a resync. From
// v2.5.12 the same demand exits with 78 (EX_CONFIG), changed upstream in
// abraunegg/onedrive#3799 and reported to us in issue #11. A supervisor that
// only knows 126 treats 78 as a crash: it restarts without --resync, the client
// refuses again, and the account never syncs. Both codes must be granted.
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
  process.env.FAKE_RESYNC_EXIT = "78";
  env = await bootstrap();
  instance = env.instances.createInstance({ name: "Newer Client", type: "personal" });
  writeFileSync(env.instances.refreshTokenPath(instance), "test-token\n");
});

after(async () => {
  await env.supervisor.stopAll();
  delete process.env.FAKE_DEMAND_RESYNC;
  delete process.env.FAKE_RESYNC_EXIT;
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

test("exit 78 from a newer client is granted a resync like 126", async () => {
  env.supervisor.start(instance);

  const recovered = await waitFor(() => logHas("requires a resync"), 15_000);
  assert.ok(recovered, "exit 78 was recognised as a resync demand");

  const resynced = await waitFor(() => logHas("Performing a database resync"), 15_000);
  assert.ok(resynced, "the restart carried --resync to the client");

  const up = await waitFor(() => logHas("Starting monitor mode"), 15_000);
  assert.ok(up, "the account ends up syncing");

  const status = env.supervisor.status(instance.id);
  assert.equal(status.running, true);
  assert.equal(status.failures, 0, "the demand did not count as a crash");
});
