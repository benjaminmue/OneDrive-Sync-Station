// sync_list handling: writing, clearing and the distinction between an empty
// file (syncs nothing) and no file at all (syncs everything).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "./helpers.mjs";

let env;
let instance;
let file;

before(async () => {
  env = await bootstrap();
  instance = env.instances.createInstance({ name: "Personal", type: "personal" });
  file = join(env.root, "config", "instances", instance.id, "sync_list");
});

after(() => env.cleanup());

test("no sync_list means everything is synced", () => {
  const current = env.synclist.read(instance);
  assert.equal(current.exists, false);
  assert.equal(current.text, "");
});

test("writing rules creates the file", () => {
  const stored = env.synclist.write(instance, "/Documents/\r\n!/Documents/temp*");
  assert.equal(stored.exists, true);
  assert.equal(stored.text, "/Documents/\n!/Documents/temp*\n");
  assert.ok(existsSync(file));
});

test("clearing the editor removes the file instead of syncing nothing", () => {
  const stored = env.synclist.write(instance, "   \n\n");
  assert.equal(stored.exists, false);
  assert.ok(!existsSync(file));
});

test("a comment-only list counts as empty", () => {
  const stored = env.synclist.write(instance, "# only a note\n# and another");
  assert.equal(stored.exists, false);
  assert.ok(!existsSync(file));
});

test("invalid contents are refused before anything is written", () => {
  env.synclist.write(instance, "/Documents/");
  assert.throws(
    () => env.synclist.write(instance, "x".repeat(64 * 1024 + 1)),
    (err) => err.reason === "too-large"
  );
  // The previous, valid list must still be intact.
  assert.equal(env.synclist.read(instance).text, "/Documents/\n");
});
