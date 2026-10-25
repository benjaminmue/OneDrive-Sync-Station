// The resync demand as client v2.5.11 reports it.
//
// The image ships v2.5.12, which exits with 78 (EX_CONFIG) when it requires a
// resync (abraunegg/onedrive#3799, reported to us in issue #11). Up to v2.5.11
// the same demand exits with 126. An image rolled back to the older client must
// still have its demands granted: a supervisor that only knows 78 would treat
// 126 as a crash, restart without --resync, and the account would never sync.
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
  process.env.FAKE_RESYNC_EXIT = "126";
  env = await bootstrap();
  instance = env.instances.createInstance({ name: "Older Client", type: "personal" });
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

test("exit 126 from an older client is granted a resync like 78", async () => {
  env.supervisor.start(instance);

  const recovered = await waitFor(() => logHas("requires a resync"), 15_000);
  assert.ok(recovered, "exit 126 was recognised as a resync demand");

  const resynced = await waitFor(() => logHas("Performing a database resync"), 15_000);
  assert.ok(resynced, "the restart carried --resync to the client");

  const up = await waitFor(() => logHas("Starting monitor mode"), 15_000);
  assert.ok(up, "the account ends up syncing");

  const status = env.supervisor.status(instance.id);
  assert.equal(status.running, true);
  assert.equal(status.failures, 0, "the demand did not count as a crash");
});
