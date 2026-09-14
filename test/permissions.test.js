// Repair of the 0600/0700 modes older versions left on synced files, which an
// SMB share could not open.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "./helpers.mjs";

const skipOnWindows = process.platform === "win32" ? "POSIX modes only" : false;

let env;
let app;
let cookie = "";
let previousUmask;
let permissions;

const mode = (path) => (statSync(path).mode & 0o777).toString(8);

before(async () => {
  // Unraid's convention and the image default, independent of the shell that
  // happens to run the tests.
  previousUmask = process.umask(0o002);
  env = await bootstrap();
  app = await env.app.createApp();
  permissions = await import("../src/permissions.js");
  const res = await app.inject({
    method: "POST",
    url: "/api/setup-password",
    payload: { password: "correct-horse" },
  });
  const session = res.cookies.find((c) => c.name === "odss_session");
  cookie = `${session.name}=${session.value}`;
});

after(async () => {
  await app.close();
  env.cleanup();
  process.umask(previousUmask);
});

/**
 * Lay out an account folder the way the client used to leave it, plus entries
 * the repair has to leave alone.
 * @param {string} name Account name.
 * @returns {{instance: object, data: string, outside: string, outsideDir: string, hardlinked: string}} The account and its paths.
 */
function oldAccount(name) {
  const instance = env.instances.createInstance({ name, type: "personal" });
  const data = join(env.root, "data", instance.folder);
  mkdirSync(join(data, "Reports", "2026"), { recursive: true });
  writeFileSync(join(data, "Reports", "2026", "q3.xlsx"), "x");
  writeFileSync(join(data, "readme.txt"), "x");
  writeFileSync(join(data, "shared.txt"), "x");
  writeFileSync(join(data, "private.key"), "x");
  chmodSync(join(data, "Reports", "2026", "q3.xlsx"), 0o600);
  chmodSync(join(data, "readme.txt"), 0o600);
  chmodSync(join(data, "shared.txt"), 0o640);
  chmodSync(join(data, "private.key"), 0o400);
  chmodSync(join(data, "Reports", "2026"), 0o700);
  chmodSync(join(data, "Reports"), 0o700);
  chmodSync(data, 0o700);

  // A 0600 file outside the account, reachable only through a symlink.
  const outside = join(env.root, `outside-${instance.id}.txt`);
  writeFileSync(outside, "x");
  chmodSync(outside, 0o600);
  symlinkSync(outside, join(data, "link.txt"));

  // A 0700 folder outside the account, linked in as if it were a subfolder.
  const outsideDir = join(env.root, `outside-dir-${instance.id}`);
  mkdirSync(outsideDir);
  chmodSync(outsideDir, 0o700);
  symlinkSync(outsideDir, join(data, "Linked"));

  // A second name inside the account for a 0600 file that lives elsewhere.
  const hardlinked = join(env.root, `hardlinked-${instance.id}.txt`);
  writeFileSync(hardlinked, "x");
  chmodSync(hardlinked, 0o600);
  linkSync(hardlinked, join(data, "hardlink.txt"));
  return { instance, data, outside, outsideDir, hardlinked };
}

test("client-created files and folders get the modes UMASK gives", { skip: skipOnWindows }, async () => {
  const { instance, data, outside, outsideDir, hardlinked } = oldAccount("Old Files");

  const result = await permissions.repairDataModes(instance);

  assert.deepEqual(result, { files: 2, folders: 3, failed: 0, fileMode: "0664", folderMode: "0775" });
  assert.equal(mode(join(data, "Reports", "2026", "q3.xlsx")), "664");
  assert.equal(mode(join(data, "readme.txt")), "664");
  assert.equal(mode(join(data, "Reports", "2026")), "775");
  assert.equal(mode(join(data, "Reports")), "775");
  assert.equal(mode(data), "775");
  // Not the client's fingerprint, so not touched.
  assert.equal(mode(join(data, "shared.txt")), "640");
  assert.equal(mode(join(data, "private.key")), "400");
  // Nothing outside the account changes, whichever way it is reachable.
  assert.equal(mode(outside), "600");
  assert.equal(mode(outsideDir), "700");
  assert.equal(mode(hardlinked), "600");

  // A second run finds nothing left to do.
  const again = await permissions.repairDataModes(instance);
  assert.equal(again.files + again.folders + again.failed, 0);
});

test("an account folder replaced by a symlink is refused", { skip: skipOnWindows }, async () => {
  // The folder sits in the share, so anyone who can write there can put a link
  // in its place, for example to the config volume with the refresh tokens.
  const instance = env.instances.createInstance({ name: "Swapped Root", type: "personal" });
  const target = join(env.root, "config", "instances", instance.id);
  const secret = join(target, "refresh_token");
  writeFileSync(secret, "x");
  chmodSync(secret, 0o600);
  const data = join(env.root, "data", instance.folder);
  rmSync(data, { recursive: true });
  symlinkSync(target, data);

  const result = await permissions.repairDataModes(instance);

  assert.equal(result.files + result.folders, 0);
  assert.equal(result.failed, 1);
  assert.equal(mode(secret), "600");
  assert.equal(mode(target), "700");
});

test("entries are only opened when they really lie below the account folder", { skip: skipOnWindows }, async () => {
  // The walk filters symlinks by directory entry first, so this is the last
  // line of defence for an entry swapped between listing and opening.
  const { data, outside, outsideDir } = oldAccount("Open Inside");
  const rootReal = realpathSync(data);

  assert.equal(await permissions.openInside(join(data, "link.txt"), false, rootReal), null);
  assert.equal(await permissions.openInside(join(data, "Linked"), true, rootReal), null);
  assert.equal(await permissions.openInside(outside, false, rootReal), null);
  assert.equal(await permissions.openInside(outsideDir, true, rootReal), null);
  // The folder itself is not below itself.
  assert.equal(await permissions.openInside(rootReal, true, rootReal), null);

  const handle = await permissions.openInside(join(data, "readme.txt"), false, rootReal);
  assert.ok(handle, "a real file inside is opened");
  await handle.close();
});

test("an account without a folder yet has nothing to repair", { skip: skipOnWindows }, async () => {
  const instance = env.instances.createInstance({ name: "No Folder", type: "personal" });
  rmSync(join(env.root, "data", instance.folder), { recursive: true });

  const result = await permissions.repairDataModes(instance);
  assert.equal(result.files + result.folders + result.failed, 0);
});

test("an unreadable data volume is reported, not passed off as nothing to do", {
  skip: skipOnWindows || (process.getuid?.() === 0 ? "root reads it anyway" : false),
}, async () => {
  const { instance } = oldAccount("Unreadable Volume");
  const dataDir = join(env.root, "data");
  chmodSync(dataDir, 0o000);
  try {
    const result = await permissions.repairDataModes(instance);
    assert.equal(result.files + result.folders, 0);
    assert.equal(result.failed, 1);
  } finally {
    chmodSync(dataDir, 0o775);
  }
});

test("a private UMASK changes nothing", { skip: skipOnWindows }, async () => {
  const { instance, data } = oldAccount("Private Umask");

  const restore = process.umask(0o077);
  try {
    const result = await permissions.repairDataModes(instance);
    assert.equal(result.files + result.folders + result.failed, 0);
  } finally {
    process.umask(restore);
  }
  assert.equal(mode(join(data, "readme.txt")), "600");
  assert.equal(mode(join(data, "Reports")), "700");
});

test("the API refuses the repair without a web UI session and runs it with one", { skip: skipOnWindows }, async () => {
  const { data } = oldAccount("Via Api");

  const denied = await app.inject({ method: "POST", url: "/api/instances/via-api/repair-permissions" });
  assert.equal(denied.statusCode, 401);
  assert.equal(mode(join(data, "readme.txt")), "600");

  const res = await app.inject({
    method: "POST",
    url: "/api/instances/via-api/repair-permissions",
    headers: { cookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).files, 2);
  assert.equal(mode(join(data, "readme.txt")), "664");

  const unknown = await app.inject({
    method: "POST",
    url: "/api/instances/nobody/repair-permissions",
    headers: { cookie },
  });
  assert.equal(unknown.statusCode, 400);
});

test("a second repair of the same account is refused while one runs", { skip: skipOnWindows }, async () => {
  const { instance } = oldAccount("Double Click");

  const first = permissions.repairDataModes(instance);
  await assert.rejects(permissions.repairDataModes(instance), (err) => err.statusCode === 409);
  await first;
  // Released afterwards, so the account is not locked for good.
  const later = await permissions.repairDataModes(instance);
  assert.equal(later.failed, 0);
});
