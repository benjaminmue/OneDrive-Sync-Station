// A client that keeps demanding a resync must keep receiving one.
//
// The station grants the demand once and then treats further exits as ordinary
// failures. That covered the case it was written for, but if the very start
// carrying --resync exits 126 again, the grant is already spent: every later
// restart omitted the flag, was refused for the same reason, and the account
// restarted forever without ever doing what the client asked for. Found by the
// Codex review.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let instance;

before(async () => {
  process.env.FAKE_DEMAND_RESYNC = "always";
  env = await bootstrap();
  instance = env.instances.createInstance({ name: "Stubborn", type: "personal" });
});

after(async () => {
  delete process.env.FAKE_DEMAND_RESYNC;
  await env.supervisor.stop(instance.id);
  env.cleanup();
});

test("every restart still carries --resync, and the backoff grows", async () => {
  env.supervisor.start(instance);

  // Several rounds, so the second and third demand are covered rather than only
  // the first grant.
  const reached = await waitFor(() => {
    const s = env.supervisor.status(instance.id);
    return s.lastExit?.code === 126 && s.failures >= 2;
  }, 20000);
  assert.ok(reached, "the account went through repeated demands");

  const status = env.supervisor.status(instance.id);
  assert.equal(status.wantRunning, true, "it is still trying");
  assert.ok(status.failures >= 2, "failures are counted so the delay grows");
  assert.equal(status.resyncPending, true, "and the next start asks for the resync again");
});
