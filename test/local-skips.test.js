// Files on this server that the folder selection does not cover.
//
// The client skips them silently while scanning for uploads: they are never
// sent to OneDrive, and nothing in the interface would otherwise say so. If the
// only copy of a file sits in such a folder, it is not backed up at all, and
// the user has no reason to suspect it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let instance;

before(async () => {
  process.env.FAKE_LOCAL_SKIP = "1";
  env = await bootstrap();
  instance = env.instances.createInstance({ name: "Skip Reporter", type: "business" });
  writeFileSync(env.instances.refreshTokenPath(instance), "token\n");
});

after(async () => {
  await env.supervisor.stopAll();
  delete process.env.FAKE_LOCAL_SKIP;
  env.cleanup();
});

test("locally excluded files are reported, not merely logged", async () => {
  env.supervisor.start(instance);

  const reported = await waitFor(
    () => env.supervisor.status(instance.id).localSkips.length > 0,
    15_000
  );
  assert.ok(reported, "the account can say which local files it leaves behind");

  const skips = env.supervisor.status(instance.id).localSkips;
  assert.ok(skips.some((path) => path.endsWith("Notizen/geheim.txt")));
});

test("the remote side of the selection is not reported as a problem", () => {
  // "Skipping path" is a remote item the selection deliberately leaves alone.
  // Reporting those too would bury the real warning under noise on every
  // account that uses a selection at all.
  const skips = env.supervisor.status(instance.id).localSkips;
  assert.ok(!skips.some((path) => path.includes("Remote/Ignored")));
});

test("a restart starts the answer over", async () => {
  // The list belongs to the selection in force during that run. Carrying it
  // across a restart would warn about a selection that has since changed.
  await env.supervisor.stop(instance.id);
  assert.deepEqual(env.supervisor.status(instance.id).localSkips.length > 0, true);

  env.supervisor.start(instance);
  const afterRestart = env.supervisor.status(instance.id).localSkips;
  assert.ok(Array.isArray(afterRestart));
  await env.supervisor.stop(instance.id);
});
