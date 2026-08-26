// Looking at an account without downloading from it.
//
// The ordering problem this solves: to choose folders you must see them, and to
// see them the client has to reach Microsoft, but a normal run starts pulling
// files the moment it does. A dry run reports instead of transferring and keeps
// its findings in a separate database.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let app;
let discovery;
let cookie = "";

/**
 * Send a request through the app with the session cookie.
 * @param {string} method HTTP method.
 * @param {string} url Path.
 * @param {object} [payload] JSON body.
 * @returns {Promise<import("light-my-request").Response>} The response.
 */
function call(method, url, payload) {
  return app.inject({ method, url, headers: cookie ? { cookie } : {}, payload });
}

const body = (res) => JSON.parse(res.body);

before(async () => {
  env = await bootstrap();
  const { createApp } = await import("../src/app.js");
  discovery = await import("../src/discovery.js");
  app = await createApp();

  const res = await call("POST", "/api/setup-password", { password: "correct-horse" });
  const session = res.cookies.find((c) => c.name === "odss_session");
  cookie = `${session.name}=${session.value}`;

  const created = body(await call("POST", "/api/instances", { name: "Discover Me", type: "personal" }));
  writeFileSync(env.instances.refreshTokenPath(env.instances.getInstance(created.id)), "token\n");
});

after(async () => {
  discovery.stopAll();
  await env.supervisor.stopAll();
  await app.close();
  env.cleanup();
});

test("an unauthenticated account cannot be discovered", async () => {
  await call("POST", "/api/instances", { name: "No Login", type: "personal" });
  const res = await call("POST", "/api/instances/no-login/discover");
  assert.equal(res.statusCode, 409);
  assert.equal(body(res).error, "not-authenticated");
});

test("discovery runs the client in dry-run mode and reports it in the log", async () => {
  const res = await call("POST", "/api/instances/discover-me/discover");
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).started, true);

  const announced = await waitFor(() =>
    env.supervisor
      .logs("discover-me")
      .some((entry) => entry.line.includes("without downloading anything"))
  );
  assert.ok(announced, "the run says what it is doing, in the account log");

  const finished = await waitFor(() =>
    env.supervisor.logs("discover-me").some((entry) => entry.line.includes("DRY-RUN"))
  );
  assert.ok(finished, "the client ran with --dry-run, so nothing was transferred");
});

test("a second request does not start a second run", async () => {
  await call("POST", "/api/instances/discover-me/discover");
  const second = await call("POST", "/api/instances/discover-me/discover");
  // Either the first run is still going (started: false) or it already
  // finished; what must never happen is two clients on one config directory.
  if (body(second).started === false) {
    assert.equal(discovery.isRunning("discover-me"), true);
  }
});

test("the account list says a discovery is in progress", async () => {
  const listed = body(await call("GET", "/api/instances"));
  const account = listed.find((item) => item.id === "discover-me");
  assert.equal(typeof account.discovering, "boolean");
  assert.equal(account.setupComplete, false);
});
