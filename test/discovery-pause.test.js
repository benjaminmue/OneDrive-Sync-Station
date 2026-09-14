// The sync client and the dry-run fallback of a folder listing must never run
// on the same config directory at once.
//
// Graph is switched off here, so every discovery run goes to the dry run. The
// stub client holds that run open for a while, which is the window in which a
// pending restart or a press of Start used to be able to slip a second client in.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let app;
let cookie = "";
let discovery;

const post = (url, payload) =>
  app.inject({ method: "POST", url, headers: { cookie }, payload });

before(async () => {
  env = await bootstrap();
  discovery = await import("../src/discovery.js");
  app = await env.app.createApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/setup-password",
    payload: { password: "correct-horse" },
  });
  const session = res.cookies.find((c) => c.name === "odss_session");
  cookie = `${session.name}=${session.value}`;
});

after(async () => {
  delete process.env.FAKE_MONITOR_EXIT;
  delete process.env.FAKE_DRY_RUN_HOLD_MS;
  await Promise.all([discovery.stopAll(), env.supervisor.stopAll()]);
  await app.close();
  env.cleanup();
});

test("a client waiting to restart is held back for the whole dry run", async () => {
  const instance = env.instances.createInstance({ name: "Backoff", type: "business" });
  writeFileSync(env.instances.refreshTokenPath(instance), "token\n");
  env.synclist.write(instance, "/Scans/\n");

  // A monitor that dies at once leaves the account with no process but an
  // armed restart timer, five seconds out.
  process.env.FAKE_MONITOR_EXIT = "1";
  env.supervisor.start(instance);
  assert.ok(
    await waitFor(() => {
      const status = env.supervisor.status(instance.id);
      return !status.running && status.wantRunning;
    }),
    "the client is in its restart backoff"
  );

  // Longer than the backoff, so a timer left armed would fire inside the run.
  process.env.FAKE_DRY_RUN_HOLD_MS = "6500";
  const res = await post(`/api/instances/${instance.id}/discover`);
  assert.equal(res.statusCode, 200);
  assert.ok(await waitFor(() => discovery.holdsClient(instance.id)), "the dry run took over");

  let clientRanDuringDryRun = false;
  let startRefused = null;
  while (discovery.isRunning(instance.id)) {
    if (discovery.holdsClient(instance.id)) {
      if (env.supervisor.status(instance.id).running) clientRanDuringDryRun = true;
      if (startRefused === null) {
        const start = await post(`/api/instances/${instance.id}/start`);
        startRefused = start.statusCode === 409 && JSON.parse(start.body).error === "discovery-running";
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  delete process.env.FAKE_DRY_RUN_HOLD_MS;

  assert.equal(clientRanDuringDryRun, false, "no client ran next to the dry run");
  assert.equal(startRefused, true, "Start was refused while the dry run held the account");
  assert.equal(env.supervisor.status(instance.id).wantRunning, true, "the client was resumed afterwards");
  await env.supervisor.stop(instance.id);
  delete process.env.FAKE_MONITOR_EXIT;
});

test("a restart asked for while the client is being paused does not bring it back", async () => {
  // A selection saved in the moment between the pause signal and the client's
  // exit calls restart, which re-arms the client. The hold has to outlast that.
  const instance = env.instances.createInstance({ name: "Saved Meanwhile", type: "personal" });
  writeFileSync(env.instances.refreshTokenPath(instance), "token\n");
  env.synclist.write(instance, "/Old/\n");
  env.supervisor.start(instance);
  assert.ok(await waitFor(() => env.supervisor.status(instance.id).running));

  process.env.FAKE_DRY_RUN_HOLD_MS = "6500";
  discovery.start(instance);
  // Same tick: the pause has been signalled, the client has not exited yet.
  await app.inject({
    method: "PUT",
    url: `/api/instances/${instance.id}/synclist`,
    headers: { cookie },
    payload: { text: "/New/\n" },
  });

  let clientRanDuringDryRun = false;
  while (discovery.isRunning(instance.id)) {
    if (discovery.holdsClient(instance.id) && env.supervisor.status(instance.id).running) {
      clientRanDuringDryRun = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  delete process.env.FAKE_DRY_RUN_HOLD_MS;

  assert.equal(clientRanDuringDryRun, false, "no client ran next to the dry run");
  assert.ok(await waitFor(() => env.supervisor.status(instance.id).running), "resumed afterwards");
  assert.equal(env.synclist.read(instance).text, "/New/\n", "the saved selection is in force");
  await env.supervisor.stop(instance.id);
});

test("a Stop during the dry run is respected when it ends", async () => {
  const instance = env.instances.createInstance({ name: "Stopped Meanwhile", type: "personal" });
  writeFileSync(env.instances.refreshTokenPath(instance), "token\n");
  env.synclist.write(instance, "/Scans/\n");
  env.supervisor.start(instance);
  assert.ok(await waitFor(() => env.supervisor.status(instance.id).running));

  process.env.FAKE_DRY_RUN_HOLD_MS = "1500";
  discovery.start(instance);
  assert.ok(await waitFor(() => discovery.holdsClient(instance.id)));
  await post(`/api/instances/${instance.id}/stop`);
  assert.ok(await waitFor(() => !discovery.isRunning(instance.id), 10_000));
  delete process.env.FAKE_DRY_RUN_HOLD_MS;

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(env.supervisor.status(instance.id).running, false, "the account stayed stopped");
  assert.equal(env.supervisor.status(instance.id).wantRunning, false);
});

test("stopping all runs waits for them and emits one end each", async () => {
  const instance = env.instances.createInstance({ name: "Cancelled", type: "personal" });
  writeFileSync(env.instances.refreshTokenPath(instance), "token\n");

  process.env.FAKE_DRY_RUN_HOLD_MS = "5000";
  const ends = [];
  const onRun = ({ id, running }) => {
    if (id === instance.id && !running) ends.push(Date.now());
  };
  discovery.events.on("discovery", onRun);
  discovery.start(instance);
  assert.ok(await waitFor(() => discovery.holdsClient(instance.id)));

  await discovery.stopAll();
  delete process.env.FAKE_DRY_RUN_HOLD_MS;
  discovery.events.off("discovery", onRun);

  assert.equal(discovery.isRunning(instance.id), false, "stopAll waited for the run to end");
  assert.equal(ends.length, 1, "exactly one end event");
});
