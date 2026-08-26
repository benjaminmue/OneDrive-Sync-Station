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
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
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

test("the client rejects a resync alongside this lookup, so none is attempted", async () => {
  const instance = env.instances.requireInstance("work");
  writeFileSync(join(confDir, ".needs-resync"), "");
  const res = await env.onedrive.getSharePointDriveId(instance, "Marketing");
  assert.doesNotMatch(res.text, /cannot be used with --resync/);
  assert.equal(res.ok, true);
  rmSync(join(confDir, ".needs-resync"));
});

test("a lookup succeeds while the account is refusing to run", async () => {
  const instance = env.instances.requireInstance("work");

  const first = await env.onedrive.getSharePointDriveId(instance, "Marketing");
  assert.equal(first.ok, true, "no resync is outstanding yet");
  assert.equal(first.isolated, false, "so no isolation was needed");
  assert.equal(first.attempt, "direct");
  assert.equal(first.libraries.length, 2);

  // Put the account into the state the real client lands in after a
  // configuration change, and after the very first sign-in.
  writeFileSync(join(confDir, ".needs-resync"), "");

  const second = await env.onedrive.getSharePointDriveId(instance, "Marketing");
  assert.equal(second.ok, true, "the lookup still answers");
  assert.equal(second.isolated, true, "and says it had to step aside to do it");
  assert.equal(second.attempt, "isolated");
  assert.deepEqual(
    second.libraries.map((entry) => entry.driveId),
    ["b!FAKEDRIVEID123", "b!FAKEDRIVEID456"]
  );
});

test("the item database of the account survives the lookup", () => {
  assert.equal(readFileSync(join(confDir, "items.sqlite3"), "utf8"), "pretend-item-database");
});

test("the rotated refresh token is written back to the account", () => {
  // The value names the directory the client rotated it in. Seeing the
  // throwaway directory's name here is the proof it was copied back.
  assert.equal(readFileSync(join(confDir, "refresh_token"), "utf8"), "rotated-in-work.lookup");
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
  // Named, so the interface can say what to do instead of showing raw output.
  assert.equal(res.attempt, "no-token");
  assert.match(res.text, /resync is required/);
});

test("a pasted library URL is reduced to the site name", async () => {
  const { siteNameFrom } = env.onedrive;

  // What the browser shows while looking at the library.
  assert.equal(
    siteNameFrom("https://bebamu.sharepoint.com/sites/instagram/Freigegebene%20Dokumente/Forms/AllItems.aspx"),
    "instagram"
  );
  // Teams-provisioned sites live under a different segment.
  assert.equal(siteNameFrom("https://x.sharepoint.com/teams/Marketing/Shared%20Documents"), "Marketing");
  // Encoded characters in the site name itself survive.
  assert.equal(siteNameFrom("https://x.sharepoint.com/sites/Bau%20Team"), "Bau Team");
  // A plain name is left alone.
  assert.equal(siteNameFrom("instagram"), "instagram");
  assert.equal(siteNameFrom("  Marketing  "), "Marketing");
  // Malformed encoding is not worth failing a lookup over.
  assert.equal(siteNameFrom("https://x.sharepoint.com/sites/100%"), "100%");
});

test("the lookup reports the site it actually asked for", async () => {
  const instance = env.instances.requireInstance("work");
  const res = await env.onedrive.getSharePointDriveId(
    instance,
    "https://bebamu.sharepoint.com/sites/instagram/Freigegebene%20Dokumente/Forms/AllItems.aspx"
  );
  assert.equal(res.site, "instagram");
  assert.equal(res.libraries[0].name, "instagram Documents");
});

test("a lookup refused even in its own directory reports, and does not crash", async () => {
  const instance = env.instances.requireInstance("work");
  writeFileSync(join(confDir, ".needs-resync"), "");
  process.env.FAKE_LOOKUP_ALWAYS_REFUSED = "1";

  try {
    const res = await env.onedrive.getSharePointDriveId(instance, "Marketing");
    assert.equal(res.ok, false);
    assert.equal(res.attempt, "isolated-still-refused");
    // The directory listing is the whole point of this path: the refusal blames
    // a configuration file, and this says which files were actually present.
    assert.match(res.text, /\[station\] isolated run, directory held: /);
    assert.match(res.text, /refresh_token/);
  } finally {
    delete process.env.FAKE_LOOKUP_ALWAYS_REFUSED;
    rmSync(join(confDir, ".needs-resync"));
  }
});
