// Instance registry: directory layout, client config rendering and the rules
// that keep one instance from reaching into another one's data.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "./helpers.mjs";

let env;

before(async () => {
  env = await bootstrap();
});

after(() => env.cleanup());

test("creating an instance lays out both directories and a client config", () => {
  const instance = env.instances.createInstance({ name: "Work Business", type: "business" });

  assert.equal(instance.id, "work-business");
  assert.equal(instance.folder, "work-business");
  assert.equal(instance.driveId, null);
  assert.ok(existsSync(join(env.root, "config", "instances", "work-business")));
  assert.ok(existsSync(join(env.root, "data", "work-business")));

  const config = readFileSync(
    join(env.root, "config", "instances", "work-business", "config"),
    "utf8"
  );
  assert.match(config, /monitor_interval = "300"/);
  assert.match(config, /threads = "8"/);
  // Paths are passed on the command line instead, so they must not be in here.
  assert.ok(!config.includes("sync_dir"));
});

test("the client config leaves file modes to UMASK", () => {
  // Without it every download lands as 0600 and every folder as 0700, which an
  // SMB share cannot read even with PUID, PGID and UMASK set correctly.
  const config = readFileSync(
    join(env.root, "config", "instances", "work-business", "config"),
    "utf8"
  );
  assert.match(config, /^disable_permission_set = "true"$/m);
});

test("a SharePoint instance requires a drive id and writes it to the config", () => {
  assert.throws(
    () => env.instances.createInstance({ name: "Marketing", type: "sharepoint" }),
    (err) => err.reason === "required-for-sharepoint"
  );

  const instance = env.instances.createInstance({
    name: "Marketing Library",
    type: "sharepoint",
    driveId: "b!AbC-123_x==",
  });
  const config = readFileSync(
    join(env.root, "config", "instances", instance.id, "config"),
    "utf8"
  );
  assert.match(config, /drive_id = "b!AbC-123_x=="/);
});

test("duplicate ids and folders are refused", () => {
  assert.throws(
    () => env.instances.createInstance({ name: "Work Business", type: "personal" }),
    (err) => err.reason === "already-exists"
  );
});

test("option values that would break the client config are refused", () => {
  assert.throws(
    () =>
      env.instances.createInstance({
        name: "Injected",
        type: "personal",
        options: { skipFile: 'x"\nsync_dir = "/etc' },
      }),
    (err) => err.reason === "invalid-characters"
  );
  // The rejected instance must not have been registered.
  assert.equal(env.instances.getInstance("injected"), null);
});

test("download only and upload only cannot both be set", () => {
  assert.throws(
    () =>
      env.instances.createInstance({
        name: "Both Ways",
        type: "personal",
        options: { downloadOnly: true, uploadOnly: true },
      }),
    (err) => err.reason === "conflicts-with-download-only"
  );
});

test("updating options re-renders the client config", () => {
  const updated = env.instances.updateInstance("work-business", {
    options: { monitorInterval: 900, skipDotfiles: true },
  });
  assert.equal(updated.options.monitorInterval, 900);

  const config = readFileSync(
    join(env.root, "config", "instances", "work-business", "config"),
    "utf8"
  );
  assert.match(config, /monitor_interval = "900"/);
  assert.match(config, /skip_dotfiles = "true"/);
});

test("the id and the data folder are immutable", () => {
  const updated = env.instances.updateInstance("work-business", {
    id: "somewhere-else",
    folder: "somewhere-else",
  });
  assert.equal(updated.id, "work-business");
  assert.equal(updated.folder, "work-business");
});

test("an unknown instance is reported as such", () => {
  assert.throws(
    () => env.instances.requireInstance("does-not-exist"),
    (err) => err.reason === "unknown-instance"
  );
  assert.throws(
    () => env.instances.requireInstance("../../etc"),
    (err) => err.reason === "invalid-slug"
  );
});

test("safeJoin refuses to leave its base directory", () => {
  assert.throws(() => env.config.safeJoin(join(env.root, "data"), "../config"), /escapes base/);
});

test("deleting an instance keeps its files unless asked otherwise", () => {
  env.instances.createInstance({ name: "Temp One", type: "personal" });
  env.instances.deleteInstance("temp-one");
  assert.ok(!existsSync(join(env.root, "config", "instances", "temp-one")));
  assert.ok(existsSync(join(env.root, "data", "temp-one")));

  env.instances.createInstance({ name: "Temp Two", type: "personal" });
  env.instances.deleteInstance("temp-two", { deleteData: true });
  assert.ok(!existsSync(join(env.root, "data", "temp-two")));
});

test("every client config is rendered again from the registry", () => {
  // An account created by an older version keeps the file that version wrote
  // until something re-renders it, so a key added since would never arrive.
  const file = join(env.root, "config", "instances", "work-business", "config");
  const registered = env.instances.getInstance("work-business").options.monitorInterval;
  writeFileSync(file, 'monitor_interval = "1234"\n');

  const failed = env.instances.renderAllClientConfigs();

  assert.equal(failed.size, 0);
  const config = readFileSync(file, "utf8");
  assert.match(config, /^disable_permission_set = "true"$/m);
  assert.match(config, new RegExp(`^monitor_interval = "${registered}"$`, "m"));
  assert.ok(!config.includes("1234"));
});

test("one unwritable account does not stop the others from being rendered", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs POSIX modes as non-root" : false,
}, () => {
  const blocked = join(env.root, "config", "instances", "work-business");
  const other = join(env.root, "config", "instances", "marketing-library", "config");
  writeFileSync(other, "stale\n");
  chmodSync(blocked, 0o500);
  try {
    const failed = env.instances.renderAllClientConfigs();
    assert.deepEqual([...failed], ["work-business"]);
    assert.match(readFileSync(other, "utf8"), /disable_permission_set/);
  } finally {
    chmodSync(blocked, 0o700);
  }
});

test("options missing from an older registry fall back to their defaults", () => {
  const config = env.instances.writeClientConfig({ id: "legacy-record", options: {} });
  assert.match(config, /threads = "8"/);
  assert.ok(!config.includes("undefined"));
});
