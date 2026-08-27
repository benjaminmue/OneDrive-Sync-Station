// End to end pass over the HTTP API against the stub client: first run, sign-in
// handshake, supervision, folder selection, teardown. This is the proof that the
// pieces work together, without needing a container or a Microsoft account.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let app;
let cookie = "";

/**
 * Send a request through the app, carrying the session cookie once one exists.
 * @param {string} method HTTP method.
 * @param {string} url Path including query string.
 * @param {object} [payload] JSON body.
 * @returns {Promise<import("light-my-request").Response>} The response.
 */
function call(method, url, payload) {
  return app.inject({
    method,
    url,
    headers: cookie ? { cookie } : {},
    payload,
  });
}

/**
 * Parse a JSON response body.
 * @param {import("light-my-request").Response} res Response.
 * @returns {object} Parsed body.
 */
const body = (res) => JSON.parse(res.body);

before(async () => {
  env = await bootstrap();
  const { createApp } = await import("../src/app.js");
  app = await createApp();
});

after(async () => {
  await env.supervisor.stopAll();
  await app.close();
  env.cleanup();
});

test("a fresh station asks for a password and refuses everything else", async () => {
  const state = body(await call("GET", "/api/state"));
  assert.equal(state.setupNeeded, true);
  assert.equal(state.authed, false);
  // The stub answers --version, so the client is reported as present.
  assert.match(state.clientVersion, /onedrive v/);

  const denied = await call("GET", "/api/instances");
  assert.equal(denied.statusCode, 401);
});

test("the first-run password is enforced and opens a session", async () => {
  const tooShort = await call("POST", "/api/setup-password", { password: "short" });
  assert.equal(tooShort.statusCode, 400);
  assert.equal(body(tooShort).field, "password");

  const res = await call("POST", "/api/setup-password", { password: "correct-horse" });
  assert.equal(res.statusCode, 200);
  const session = res.cookies.find((c) => c.name === "odss_session");
  assert.ok(session, "a session cookie is set");
  assert.equal(session.httpOnly, true);
  cookie = `${session.name}=${session.value}`;

  // Setting it twice would let anyone reset the password of a running station.
  const again = await call("POST", "/api/setup-password", { password: "another-one" });
  assert.equal(again.statusCode, 409);
});

test("hostile account input is rejected with the offending field", async () => {
  const traversal = await call("POST", "/api/instances", {
    name: "Escape",
    type: "personal",
    id: "../../etc",
  });
  assert.equal(traversal.statusCode, 400);
  assert.equal(body(traversal).field, "id");

  const badType = await call("POST", "/api/instances", { name: "Nope", type: "dropbox" });
  assert.equal(badType.statusCode, 400);
  assert.equal(body(badType).field, "type");

  const configInjection = await call("POST", "/api/instances", {
    name: "Injected",
    type: "personal",
    options: { skipDir: 'a"\nsync_dir = "/etc' },
  });
  assert.equal(configInjection.statusCode, 400);
  assert.equal(body(configInjection).field, "skipDir");
});

test("an account can be created", async () => {
  const res = await call("POST", "/api/instances", { name: "Work Business", type: "business" });
  assert.equal(res.statusCode, 200);
  const instance = body(res);
  assert.equal(instance.id, "work-business");
  assert.equal(instance.authenticated, false);
  assert.match(instance.dataPath, /work-business$/);
});

test("an account that is not signed in cannot be started", async () => {
  const res = await call("POST", "/api/instances/work-business/start");
  assert.equal(res.statusCode, 409);
  assert.equal(body(res).error, "not-authenticated");
});

test("the sign-in handshake hands out a URL and accepts only a Microsoft redirect", async () => {
  const begun = body(await call("POST", "/api/instances/work-business/signin/begin"));
  assert.match(begun.authUrl, /^https:\/\/login\.microsoftonline\.com\//);

  const foreign = await call("POST", "/api/instances/work-business/signin/complete", {
    responseUrl: "https://evil.example.com/?code=stolen",
  });
  assert.equal(foreign.statusCode, 400);
  assert.equal(body(foreign).field, "responseUrl");

  // The rejected attempt must leave the handshake open, not consume it.
  const res = await call("POST", "/api/instances/work-business/signin/complete", {
    responseUrl: "https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc123",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).authenticated, true);
});

test("a fresh sign-in does not start syncing on its own", async () => {
  // The account has to wait for the user to choose folders. Starting here would
  // pull the whole account down before the selection is even on screen, which on
  // a large account means gigabytes of the wrong data.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(env.supervisor.status("work-business").running, false);
  assert.equal(body(await call("GET", "/api/instances/work-business")).setupComplete, false);
});

test("starting explicitly is what begins the sync and confirms the setup", async () => {
  // Nothing is selected here, and an empty selection means the whole account to
  // the client, so the start is refused until that is accepted in as many
  // words. Covered in detail in empty-selection.test.js.
  const refused = await call("POST", "/api/instances/work-business/start");
  assert.equal(refused.statusCode, 409);
  assert.equal(body(refused).error, "selection-empty");

  const res = await call("POST", "/api/instances/work-business/start", { acceptFullSync: true });
  assert.equal(res.statusCode, 200);

  const started = await waitFor(() => env.supervisor.status("work-business").running);
  assert.ok(started, "the client is running");

  // Starting is the moment the user accepts what will be synced, so the account
  // may come up by itself after a container restart from now on.
  assert.equal(body(await call("GET", "/api/instances/work-business")).setupComplete, true);

  const gotOutput = await waitFor(() =>
    env.supervisor.logs("work-business").some((entry) => entry.line.includes("monitor mode"))
  );
  assert.ok(gotOutput, "the client output reached the log buffer");

  const listed = body(await call("GET", "/api/instances"));
  assert.equal(listed[0].runtime.running, true);
  assert.equal(listed[0].authenticated, true);
});

test("saving a folder selection triggers the resync the client requires", async () => {
  const res = await call("PUT", "/api/instances/work-business/synclist", {
    text: "/Documents/\n!/Documents/temp*",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).exists, true);
  assert.equal(body(res).resyncTriggered, true);

  const stored = body(await call("GET", "/api/instances/work-business/synclist"));
  assert.equal(stored.text, "/Documents/\n!/Documents/temp*\n");

  // Matching on the station's own "starting with --resync" line would pass even
  // if the flag never reached the client. This is the client's own output, so
  // it only appears when the argument actually arrived.
  const resynced = await waitFor(() =>
    env.supervisor
      .logs("work-business")
      .some((entry) => entry.line.includes("Performing a database resync"))
  );
  assert.ok(resynced, "the restarted client received --resync");
});

test("the sync interval is set per account and reaches the client config", async () => {
  const res = await call("PATCH", "/api/instances/work-business", {
    options: { monitorInterval: 900 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).options.monitorInterval, 900);

  // The client reads the value from its own config file, so the setting is only
  // real once it is written there, in this account's directory alone.
  const config = await call("GET", "/api/instances/work-business/config");
  assert.match(body(config).text, /monitor_interval = "900"/);

  // Below the client's own lower bound of 300 seconds it would silently clamp,
  // so the API refuses it rather than showing a value that is not in effect.
  const tooShort = await call("PATCH", "/api/instances/work-business", {
    options: { monitorInterval: 60 },
  });
  assert.equal(tooShort.statusCode, 400);
  assert.equal(body(tooShort).field, "monitorInterval");
});

test("diagnostics and the SharePoint lookup run as the signed-in account", async () => {
  const status = body(await call("GET", "/api/instances/work-business/status"));
  assert.equal(status.ok, true);
  assert.match(status.text, /No pending remote changes/);

  const lookup = await call("POST", "/api/sharepoint/lookup", {
    instanceId: "work-business",
    site: "Marketing",
  });
  assert.equal(lookup.statusCode, 200);
  assert.equal(body(lookup).libraries.length, 2);

  const injected = await call("POST", "/api/sharepoint/lookup", {
    instanceId: "work-business",
    site: "--resync",
  });
  assert.equal(injected.statusCode, 400);
  assert.equal(body(injected).field, "site");
});

test("stopping is honoured and does not restart on its own", async () => {
  await call("POST", "/api/instances/work-business/stop");
  const stopped = await waitFor(() => !env.supervisor.status("work-business").running);
  assert.ok(stopped, "the client stopped");

  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(env.supervisor.status("work-business").running, false);
  assert.equal(env.supervisor.status("work-business").wantRunning, false);
});

test("signing out of the web UI closes the session", async () => {
  await call("POST", "/api/logout");
  const previous = cookie;
  cookie = "";
  const denied = await call("GET", "/api/instances");
  assert.equal(denied.statusCode, 401);

  // Replaying the old cookie must not work either: the session is gone server side.
  cookie = previous;
  const replayed = await call("GET", "/api/instances");
  assert.equal(replayed.statusCode, 401);
});
