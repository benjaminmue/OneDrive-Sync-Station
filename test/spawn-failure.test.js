// What happens when the client cannot be started at all.
//
// Its own file because the client path is fixed when the modules are first
// imported, and here it deliberately points at something that cannot run.
//
// This is the case that used to wedge an instance permanently: a failed spawn
// emits 'error' and 'close' but never 'exit', so an exit-only handler left the
// child reference in place forever. The instance then reported itself running
// while doing nothing, and start, stop and restart all became no-ops.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let instance;

before(async () => {
  env = await bootstrap({ clientBin: "onedrive-binary-that-does-not-exist" });
  instance = env.instances.createInstance({ name: "Broken Client", type: "personal" });
  writeFileSync(env.instances.refreshTokenPath(instance), "test-token\n");
});

after(async () => {
  await env.supervisor.stopAll();
  env.cleanup();
});

test("a failed spawn does not leave the instance stuck reporting itself as running", async () => {
  env.supervisor.start(instance);

  const settled = await waitFor(() => env.supervisor.status(instance.id).running === false, 5000);
  assert.ok(settled, "the runner released the child reference");

  const status = env.supervisor.status(instance.id);
  assert.equal(status.pid, null);
  assert.equal(status.lastExit?.spawnFailed, true);
  assert.ok(status.failures >= 1, "the failure counts towards the backoff");
});

test("the failure is visible in the instance log", () => {
  const failed = env.supervisor
    .logs(instance.id)
    .some((entry) => entry.line.includes("failed to start client"));
  assert.ok(failed, "the user can see why nothing is syncing");
});

test("stop recovers a wedged instance instead of hanging", async () => {
  // Nothing is running, so this must resolve immediately rather than wait for
  // an exit that will never come.
  await env.supervisor.stop(instance.id);
  const status = env.supervisor.status(instance.id);
  assert.equal(status.running, false);
  assert.equal(status.wantRunning, false);
});
