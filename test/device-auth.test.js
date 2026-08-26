// Sign-in with a device code.
//
// This flow exists because the other one is barely usable in practice: after a
// real sign-in, Microsoft's redirect page warns about phishing and then
// redirects itself away before most people can copy the address out of it.
// Here nothing is copied back at all, the client polls Microsoft itself.
//
// Its own file because the stub client is steered through the environment.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let app;
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
  process.env.FAKE_DEVICE_AUTH = "1";
  env = await bootstrap();
  const { createApp } = await import("../src/app.js");
  app = await createApp();

  const res = await call("POST", "/api/setup-password", { password: "correct-horse" });
  const session = res.cookies.find((c) => c.name === "odss_session");
  cookie = `${session.name}=${session.value}`;
  await call("POST", "/api/instances", { name: "Device Account", type: "business" });
});

after(async () => {
  await env.supervisor.stopAll();
  await app.close();
  delete process.env.FAKE_DEVICE_AUTH;
  env.cleanup();
});

test("the prompt is parsed out of the client output", async () => {
  const { parseDeviceCodePrompt } = await import("../src/authflow.js");
  const parsed = parseDeviceCodePrompt(
    "Authorise this application by visiting:\nhttps://microsoft.com/devicelogin\n" +
      "Enter the following code when prompted: ABCD-1234\n"
  );
  assert.equal(parsed.userCode, "ABCD-1234");
  assert.equal(parsed.verificationUrl, "https://microsoft.com/devicelogin");
  assert.equal(parseDeviceCodePrompt("nothing useful here"), null);
});

test("starting a device sign-in returns the code and enables the option", async () => {
  const res = await call("POST", "/api/instances/device-account/signin/begin", {
    useDeviceAuth: true,
  });
  assert.equal(res.statusCode, 200);
  const started = body(res);
  assert.equal(started.mode, "device");
  assert.equal(started.userCode, "FAKE-CODE-123");
  assert.match(started.verificationUrl, /devicelogin/);

  // The client reads the flow from its config file, so choosing it in the UI
  // has to end up written there, not just held in memory.
  const config = body(await call("GET", "/api/instances/device-account/config"));
  assert.match(config.text, /use_device_auth = "true"/);
});

test("polling reports that it is still waiting, without blocking", async () => {
  const res = await call("POST", "/api/instances/device-account/signin/poll");
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).done, false);
  assert.equal(body(res).authenticated, false);
});

test("the account is signed in once the user confirms at Microsoft", async () => {
  // Standing in for the user entering the code on Microsoft's page.
  writeFileSync(
    join(env.root, "config", "instances", "device-account", ".device-confirmed"),
    "confirmed\n"
  );

  const done = await waitFor(async () => true, 100); // yield once
  assert.ok(done);

  let authenticated = false;
  for (let attempt = 0; attempt < 15 && !authenticated; attempt += 1) {
    const res = body(await call("POST", "/api/instances/device-account/signin/poll"));
    if (res.done) authenticated = res.authenticated;
  }
  assert.ok(authenticated, "the sign-in completed without anything being pasted back");

  const listed = body(await call("GET", "/api/instances"));
  assert.equal(listed[0].authenticated, true);
});
