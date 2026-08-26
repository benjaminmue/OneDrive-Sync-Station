// Security and robustness cases found in review: sign-in races, session
// handling, throttling, and inputs that must not be quietly coerced.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let app;
let ratelimit;
let cookie = "";

/**
 * Send a request through the app, carrying the session cookie once one exists.
 * @param {string} method HTTP method.
 * @param {string} url Path including query string.
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
  ratelimit = await import("../src/ratelimit.js");
  app = await createApp();

  const res = await call("POST", "/api/setup-password", { password: "correct-horse" });
  const session = res.cookies.find((c) => c.name === "odss_session");
  cookie = `${session.name}=${session.value}`;
});

after(async () => {
  await env.supervisor.stopAll();
  await app.close();
  env.cleanup();
});

test("a second sign-in supersedes the first instead of orphaning its client", async () => {
  await call("POST", "/api/instances", { name: "Race Account", type: "business" });

  // Two begins in flight at once, as a double click or a UI retry produces.
  const [first, second] = await Promise.allSettled([
    call("POST", "/api/instances/race-account/signin/begin"),
    call("POST", "/api/instances/race-account/signin/begin"),
  ]);

  // Exactly one attempt may survive; the other must be reported as superseded
  // rather than left running against the same config directory.
  const succeeded = [first, second].filter(
    (r) => r.status === "fulfilled" && r.value.statusCode === 200
  );
  assert.equal(succeeded.length, 1, "only one sign-in attempt survives");

  await call("POST", "/api/instances/race-account/signin/cancel");
  assert.equal(env.authflow.isPending("race-account"), false);

  // The decisive part: after a cancel, no client may still be waiting to
  // complete the sign-in behind the user's back. Writing the response file is
  // what an orphan would react to.
  const responseFile = join(env.root, "config", "auth", "race-account.response");
  writeFileSync(
    responseFile,
    "https://login.microsoftonline.com/common/oauth2/nativeclient?code=late\n"
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const instance = env.instances.getInstance("race-account");
  assert.equal(
    env.instances.isAuthenticated(instance),
    false,
    "a cancelled sign-in must not complete afterwards"
  );
});

test("cancelling a sign-in leaves no handshake files behind", async () => {
  await call("POST", "/api/instances/race-account/signin/begin");
  await call("POST", "/api/instances/race-account/signin/cancel");

  const leftovers = readdirSync(join(env.root, "config", "auth")).filter((name) =>
    name.startsWith("race-account")
  );
  // The response file carries the OAuth code; it must not linger on disk.
  assert.deepEqual(leftovers, []);
});

test("a sign-in cannot start while the monitor still holds the config directory", async () => {
  const instance = env.instances.createInstance({ name: "Held Account", type: "personal" });
  writeFileSync(env.instances.refreshTokenPath(instance), "test-token\n");

  env.supervisor.start(instance);
  await waitFor(() => env.supervisor.status(instance.id).running);

  const res = await call("POST", `/api/instances/${instance.id}/signin/begin`);
  assert.equal(res.statusCode, 200);
  // The route awaits the stop, so by the time the sign-in client exists the
  // monitor must be gone. Two clients on one config directory would race over
  // the same item database and refresh token.
  assert.equal(env.supervisor.status(instance.id).running, false);

  await call("POST", `/api/instances/${instance.id}/signin/cancel`);
});

test("a malformed folder selection is refused, not treated as an empty list", async () => {
  await call("PUT", "/api/instances/race-account/synclist", { text: "/Documents/" });
  assert.equal(body(await call("GET", "/api/instances/race-account/synclist")).exists, true);

  // Coercing these to "" would delete the file, and no sync_list means "sync
  // everything": a malformed request would turn a selective sync into a full
  // download of the whole account.
  for (const payload of [{ text: null }, { text: 123 }, {}]) {
    const res = await call("PUT", "/api/instances/race-account/synclist", payload);
    assert.equal(res.statusCode, 400, `rejected ${JSON.stringify(payload)}`);
    assert.equal(body(res).field, "syncList");
  }

  const still = body(await call("GET", "/api/instances/race-account/synclist"));
  assert.equal(still.exists, true, "the existing selection survived");
  assert.equal(still.text, "/Documents/\n");
});

test("clearing the selection explicitly still works", async () => {
  const res = await call("PUT", "/api/instances/race-account/synclist", { text: "" });
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).exists, false);
});

test("hostile options are refused on update, not only on creation", async () => {
  const res = await call("PATCH", "/api/instances/race-account", {
    options: { skipFile: 'x"\nsync_dir = "/etc' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(body(res).field, "skipFile");

  const config = join(env.root, "config", "instances", "race-account", "config");
  assert.ok(existsSync(config));
  assert.ok(!(await import("node:fs")).readFileSync(config, "utf8").includes("/etc"));
});

test("a tampered session cookie is rejected", async () => {
  const good = cookie;
  cookie = "odss_session=forged-value";
  assert.equal((await call("GET", "/api/instances")).statusCode, 401);

  // Same id, broken signature: the cookie is signed, so this must not pass.
  const [name, value] = good.split("=");
  cookie = `${name}=${value.split(".")[0]}.deadbeef`;
  assert.equal((await call("GET", "/api/instances")).statusCode, 401);

  cookie = good;
  assert.equal((await call("GET", "/api/instances")).statusCode, 200);
});

test("repeated wrong passwords are throttled", async () => {
  ratelimit.reset();
  let sawThrottle = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: `wrong-${i}` },
    });
    if (res.statusCode === 429) {
      sawThrottle = true;
      assert.ok(Number(res.headers["retry-after"]) > 0);
      break;
    }
    assert.equal(res.statusCode, 401);
  }
  assert.ok(sawThrottle, "the station stops answering a burst of guesses");
  ratelimit.reset();
});

test("changing the password invalidates every other session", async () => {
  const other = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "correct-horse" },
  });
  const otherSession = other.cookies.find((c) => c.name === "odss_session");
  const otherCookie = `${otherSession.name}=${otherSession.value}`;

  const changed = await call("POST", "/api/change-password", {
    currentPassword: "correct-horse",
    newPassword: "a-different-one",
  });
  assert.equal(changed.statusCode, 200);
  cookie = `odss_session=${changed.cookies.find((c) => c.name === "odss_session").value}`;

  const stale = await app.inject({
    method: "GET",
    url: "/api/instances",
    headers: { cookie: otherCookie },
  });
  assert.equal(stale.statusCode, 401, "the other browser is signed out");
  assert.equal((await call("GET", "/api/instances")).statusCode, 200);
});

test("the unauthenticated state endpoint reveals nothing about the host", async () => {
  const res = await app.inject({ method: "GET", url: "/api/state" });
  const state = body(res);
  assert.equal(state.authed, false);
  assert.equal(state.dataDir, undefined);
  assert.equal(state.instanceCount, undefined);
  assert.ok(state.version);
});
