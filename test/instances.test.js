// Instance registry: directory layout, client config rendering and the rules
// that keep one instance from reaching into another one's data.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
