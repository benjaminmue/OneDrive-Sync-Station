// A client that asks for a new sign-in while it should be syncing.
//
// Seen on real accounts with an empty refresh token: the client prints a device
// code nobody in a container sees, waits fifteen minutes, exits and is started
// into the same wait again. The process was alive, so the card said "Running"
// while nothing synced. The station has to stop it and say what is needed.
//
// Its own file because the stub client is steered through the environment,
// which is fixed when the modules are first imported.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let instance;

before(async () => {
  process.env.FAKE_SIGNIN_PROMPT = "1";
  env = await bootstrap();
  instance = env.instances.createInstance({ name: "Lost Token", type: "business" });
  // Not empty: the case the file check cannot see, a token the client refuses.
  writeFileSync(env.instances.refreshTokenPath(instance), "refused-token\n");
});

after(async () => {
  delete process.env.FAKE_SIGNIN_PROMPT;
  await env.supervisor.stopAll();
  env.cleanup();
});

test("a client waiting for a sign-in is stopped and reported, not restarted", async () => {
  env.supervisor.start(instance);

  const stopped = await waitFor(() => {
    const s = env.supervisor.status(instance.id);
    return s.signInRequired && !s.running;
  }, 10_000);
  assert.ok(stopped, "the client was stopped and the account flagged");

  // Longer than the restart delay: nothing may bring it back on its own.
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const status = env.supervisor.status(instance.id);
  assert.equal(status.running, false, "no restart into the same wait");
  assert.equal(status.wantRunning, false);
  assert.equal(status.failures, 0, "not counted as a crash");
  assert.equal(status.lastExit?.requested, true, "the stop was the station's own");
  assert.ok(
    env.supervisor.logs(instance.id).some((e) => e.line.includes("no valid sign-in")),
    "the log says why"
  );
});

test("starting again clears the notice", async () => {
  delete process.env.FAKE_SIGNIN_PROMPT;
  env.supervisor.start(instance);
  assert.equal(env.supervisor.status(instance.id).signInRequired, false);
  await env.supervisor.stop(instance.id);
});

test("a file named after the prompt does not stop a healthy client", async () => {
  // Found by the Codex review: the first version matched anywhere in the
  // output, so the path of an ordinary file could end a working sync.
  process.env.FAKE_PROMPT_NAMED_FILE = "1";
  env.supervisor.start(instance);
  const mentioned = await waitFor(
    () => env.supervisor.logs(instance.id).some((e) => e.line.includes("Notes/Still pending")),
    10_000
  );
  delete process.env.FAKE_PROMPT_NAMED_FILE;
  assert.ok(mentioned, "the stub printed the file names");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const status = env.supervisor.status(instance.id);
  assert.equal(status.running, true, "still syncing");
  assert.equal(status.signInRequired, false);
  await env.supervisor.stop(instance.id);
});
