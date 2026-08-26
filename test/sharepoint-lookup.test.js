// The drive id lookup has to survive an account that owes a resync.
//
// The client checks for an outstanding resync before it runs anything at all,
// a read-only lookup included, and refuses with exit 126. Granting the resync
// on the account's own directory would delete its item database, so the lookup
// is repeated in a throwaway directory instead. What has to hold: the caller
// gets its drive ids, the account's database is untouched, and the rotated
// refresh token ends up back where the account will look for it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "./helpers.mjs";

let env;
let confDir;

before(async () => {
  env = await bootstrap();
  env.instances.createInstance({ name: "work", type: "business" });
  confDir = env.config.instanceConfDir("work");
  writeFileSync(join(confDir, "refresh_token"), "original-refresh-token");
  writeFileSync(join(confDir, "items.sqlite3"), "pretend-item-database");
});

after(() => env.cleanup());

test("a lookup succeeds while the account is refusing to run", async () => {
  const instance = env.instances.requireInstance("work");

  const first = await env.onedrive.getSharePointDriveId(instance, "Marketing");
  assert.equal(first.ok, true, "no resync is outstanding yet");
  assert.equal(first.isolated, false, "so no isolation was needed");
  assert.equal(first.libraries.length, 2);

  // Put the account into the state the real client lands in after a
  // configuration change, and after the very first sign-in.
  writeFileSync(join(confDir, ".needs-resync"), "");

  const second = await env.onedrive.getSharePointDriveId(instance, "Marketing");
  assert.equal(second.ok, true, "the lookup still answers");
  assert.equal(second.isolated, true, "and says it had to step aside to do it");
  assert.deepEqual(
    second.libraries.map((entry) => entry.driveId),
    ["b!FAKEDRIVEID123", "b!FAKEDRIVEID456"]
  );
});

test("the item database of the account survives the lookup", () => {
  assert.equal(readFileSync(join(confDir, "items.sqlite3"), "utf8"), "pretend-item-database");
});

test("the rotated refresh token is written back to the account", () => {
  assert.equal(readFileSync(join(confDir, "refresh_token"), "utf8"), "rotated-refresh-token");
});

test("the throwaway directory is gone", () => {
  assert.equal(existsSync(`${confDir}.lookup`), false);
  const leftovers = readdirSync(join(confDir, "..")).filter((name) => name.endsWith(".lookup"));
  assert.deepEqual(leftovers, []);
});

test("without a token there is nothing to try, and the refusal stands", async () => {
  env.instances.createInstance({ name: "fresh", type: "business" });
  const fresh = env.instances.requireInstance("fresh");
  writeFileSync(join(env.config.instanceConfDir("fresh"), ".needs-resync"), "");

  const res = await env.onedrive.getSharePointDriveId(fresh, "Marketing");
  assert.equal(res.ok, false);
  assert.equal(res.isolated, false);
  assert.match(res.text, /resync is required/);
});
