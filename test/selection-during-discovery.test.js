// A folder selection saved while a discovery run is going must survive it.
//
// The run parks the existing selection and restores it when it ends, deleting
// whatever is in the live file at that moment. A save landing there in the
// meantime disappears without a word, and the user is left with the old
// selection and no reason to distrust it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "./helpers.mjs";

let env;
let discovery;
let instance;
let confDir;

before(async () => {
  env = await bootstrap();
  discovery = await import("../src/discovery.js");
  instance = env.instances.createInstance({ name: "Disco", type: "personal" });
  confDir = env.config.instanceConfDir(instance.id);
});

after(() => {
  discovery.stop(instance.id);
  env.cleanup();
});

test("a selection saved during a run is what the account has afterwards", async () => {
  env.synclist.write(instance, "/Old/\n");
  assert.equal(readFileSync(join(confDir, "sync_list"), "utf8").trim(), "/Old/");

  discovery.start(instance);
  assert.equal(discovery.isRunning(instance.id), true, "the run is going");
  // The run has the selection: the live file is out of the way.
  assert.equal(existsSync(join(confDir, "sync_list.discovery-backup")), true);

  env.synclist.write(instance, "/New/\n");

  await new Promise((resolve) => {
    if (!discovery.isRunning(instance.id)) return resolve();
    discovery.events.once("discovery", resolve);
  });

  assert.equal(discovery.isRunning(instance.id), false, "the run finished");
  assert.equal(
    readFileSync(join(confDir, "sync_list"), "utf8").trim(),
    "/New/",
    "the save survived the run"
  );
});

test("clearing during a run also survives it", async () => {
  env.synclist.write(instance, "/Something/\n");
  discovery.start(instance);
  env.synclist.write(instance, "# nothing selected\n");

  await new Promise((resolve) => {
    if (!discovery.isRunning(instance.id)) return resolve();
    discovery.events.once("discovery", resolve);
  });

  assert.equal(existsSync(join(confDir, "sync_list")), false, "the list is gone, not restored");
});
