// Starting an account with nothing selected downloads the whole account.
//
// That is the sync client's rule: an empty sync_list selects everything. The
// station promises the opposite, that nothing downloads unbidden, so pressing
// Start on an account with no selection has to be an explicit choice rather
// than an accident. Reported from real use: a SharePoint library began pulling
// its entire archive right after Start, with every checkbox unticked.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "./helpers.mjs";

let env;
let app;
let instance;
let cookie = "";

/**
 * Send a request through the app, carrying the session cookie once one exists.
 * @param {string} method HTTP method.
 * @param {string} url Path.
 * @param {object} [payload] JSON body.
 * @returns {Promise<import("light-my-request").Response>} The response.
 */
function call(method, url, payload) {
  return app.inject({ method, url, headers: cookie ? { cookie } : {}, payload });
}

before(async () => {
  env = await bootstrap();
  app = await env.app.createApp();

  const session = await app.inject({
    method: "POST",
    url: "/api/setup-password",
    payload: { password: "a-station-password" },
  });
  cookie = session.headers["set-cookie"].split(";")[0];

  instance = env.instances.createInstance({ name: "Library", type: "sharepoint", driveId: "b!x" });
  // Signed in as far as the start route cares.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${env.config.instanceConfDir(instance.id)}/refresh_token`, "token");
});

after(async () => {
  await app.close();
  await env.supervisor.stop(instance.id);
  env.cleanup();
});

test("start is refused while nothing is selected", async () => {
  const res = await call("POST", `/api/instances/${instance.id}/start`, {});

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "selection-empty");
  assert.equal(env.supervisor.status(instance.id).wantRunning, false, "nothing was started");
});

test("start proceeds once the whole account is accepted explicitly", async () => {
  const res = await call("POST", `/api/instances/${instance.id}/start`, { acceptFullSync: true });

  assert.equal(res.statusCode, 200);
  assert.equal(env.supervisor.status(instance.id).wantRunning, true);
  await env.supervisor.stop(instance.id);
});

test("start needs no acceptance once folders are selected", async () => {
  env.synclist.write(instance, "/_Archive/\n");

  const res = await call("POST", `/api/instances/${instance.id}/start`, {});

  assert.equal(res.statusCode, 200);
  await env.supervisor.stop(instance.id);
});
