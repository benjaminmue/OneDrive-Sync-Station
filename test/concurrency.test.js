// Races that only show up under simultaneous requests.
//
// All three were found by the Codex second-pass review. They share a shape: a
// check and the action that follows it are separated by an await, so a second
// request slips in between.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "./helpers.mjs";

let env;

before(async () => {
  env = await bootstrap();
});

after(() => env.cleanup());

test("concurrent version reads spawn exactly one client", async () => {
  // /api/state serves this without a session, so a burst of anonymous requests
  // used to start one client process each and could exhaust the container's
  // process limit from outside.
  const results = await Promise.all(Array.from({ length: 25 }, () => env.onedrive.version()));

  // Same object from every caller proves a single invocation was shared.
  for (const res of results) {
    assert.equal(res, results[0], "every caller got the one cached result");
  }
  assert.match(results[0].text, /onedrive v/);
});

test("the login throttle keys on something a client cannot choose", async () => {
  // With trustProxy on, request.ip came from X-Forwarded-For, which any client
  // sets freely, so every guess arrived with a fresh bucket. Off by default now,
  // and only enabled for the proxy addresses named in TRUSTED_PROXIES.
  const app = await env.app.createApp();
  try {
    const attempt = (forwarded) =>
      app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "x-forwarded-for": forwarded },
        payload: { password: "wrong-password-guess" },
      });

    let lastStatus = 0;
    // Each attempt claims a different origin. If the header were trusted, every
    // one of them would be a first attempt and none would ever be throttled.
    for (let i = 0; i < 12; i++) {
      const res = await attempt(`10.0.0.${i}`);
      lastStatus = res.statusCode;
      if (lastStatus === 429) break;
    }
    assert.equal(lastStatus, 429, "the throttle caught on despite the changing header");
  } finally {
    await app.close();
  }
});

test("only the first of two first-time password setups gets in", async () => {
  const app = await env.app.createApp();
  try {
    const setup = (password) =>
      app.inject({ method: "POST", url: "/api/setup-password", payload: { password } });

    const [a, b] = await Promise.all([setup("first-password-9x"), setup("second-password-9x")]);
    const codes = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(codes, [200, 409], "one succeeded, the other was refused");
  } finally {
    await app.close();
  }
});
