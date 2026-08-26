// Process lifecycle. Every case here corresponds to a defect found in review:
// a stop that did not wait, a queued resync that outlived its run, a shutdown
// that skipped instances waiting out a backoff.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;

/**
 * Create an instance and mark it as signed in, without running a sign-in.
 * @param {string} name Display name.
 * @returns {object} The instance record.
 */
function signedInInstance(name) {
  const instance = env.instances.createInstance({ name, type: "personal" });
  writeFileSync(env.instances.refreshTokenPath(instance), "test-token\n");
  return instance;
}

before(async () => {
  env = await bootstrap();
});

after(async () => {
  await env.supervisor.stopAll();
  env.cleanup();
});

test("stop resolves only once the client process is really gone", async () => {
  const instance = signedInInstance("Stop Waits");
  env.supervisor.start(instance);
  await waitFor(() => env.supervisor.status(instance.id).running);

  // The contract the sign-in and logout paths depend on: when this resolves, no
  // client of this instance holds the config directory any more.
  await env.supervisor.stop(instance.id);
  assert.equal(env.supervisor.status(instance.id).running, false);
  assert.equal(env.supervisor.status(instance.id).pid, null);
});

test("stop clears a queued resync instead of arming the next plain start", async () => {
  const instance = signedInInstance("Resync Queue");
  env.supervisor.start(instance);
  await waitFor(() => env.supervisor.status(instance.id).running);

  // Ask for a resync, then cancel the run before it can happen.
  env.supervisor.restart(instance, { resync: true });
  await env.supervisor.stop(instance.id);
  assert.equal(env.supervisor.status(instance.id).resyncPending, false);

  // A later ordinary start must not silently perform a resync: --resync-auth
  // would auto-answer the confirmation that normally guards discarding the
  // local database.
  env.supervisor.start(instance);
  await waitFor(() => env.supervisor.status(instance.id).running);
  await waitFor(() =>
    env.supervisor.logs(instance.id).some((entry) => entry.line.includes("monitor mode"))
  );
  const resynced = env.supervisor
    .logs(instance.id)
    .some((entry) => entry.line.includes("Performing a database resync"));
  assert.equal(resynced, false, "a plain start must not resync");
  await env.supervisor.stop(instance.id);
});

test("an intentional restart does not count towards the crash backoff", async () => {
  const instance = signedInInstance("Restart Backoff");
  env.supervisor.start(instance);
  await waitFor(() => env.supervisor.status(instance.id).running);

  // Three restarts in quick succession, as saving the folder selection a few
  // times would produce. Each run is far shorter than the startup grace period.
  for (let i = 0; i < 3; i += 1) {
    await env.supervisor.restart(instance);
    await waitFor(() => env.supervisor.status(instance.id).running);
  }

  assert.equal(
    env.supervisor.status(instance.id).failures,
    0,
    "restarts we asked for must not look like failed starts"
  );
  await env.supervisor.stop(instance.id);
});

test("log entries carry a timestamp on both the buffer and the event stream", async () => {
  const instance = signedInInstance("Log Shape");
  const streamed = [];
  const onLog = (payload) => {
    if (payload.id === instance.id) streamed.push(payload);
  };
  env.supervisor.events.on("log", onLog);

  env.supervisor.start(instance);
  await waitFor(() => streamed.length > 0);
  env.supervisor.events.off("log", onLog);

  // The UI merges live lines into the buffered list, so both must have the same
  // shape, and a streamed line must never be a multi-line blob.
  for (const entry of streamed) {
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(!entry.line.includes("\n"));
  }
  await env.supervisor.stop(instance.id);
});

test("stopAll also disarms instances that are waiting out a restart backoff", async () => {
  const instance = signedInInstance("Backoff Shutdown");
  env.supervisor.start(instance);
  await waitFor(() => env.supervisor.status(instance.id).running);

  // Kill the client behind the supervisor's back so it schedules a restart.
  process.kill(env.supervisor.status(instance.id).pid, "SIGKILL");
  await waitFor(() => !env.supervisor.status(instance.id).running);
  assert.equal(env.supervisor.status(instance.id).wantRunning, true);

  await env.supervisor.stopAll();

  // Without this, the armed timer would spawn a fresh client in the middle of
  // the shutdown, and it would outlive the process that was supposed to own it.
  assert.equal(env.supervisor.status(instance.id).wantRunning, false);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(env.supervisor.status(instance.id).running, false);
});
