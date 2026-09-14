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

/**
 * Run a discovery and act at the moment the dry run is demonstrably under way:
 * its first folder line. The stub client finishes in a few milliseconds, so
 * polling for that window would miss it and quietly test nothing.
 * @param {(parked: boolean) => void} during Called once, inside the run.
 * @returns {Promise<void>} Resolves when the run has ended.
 */
async function duringDryRun(during) {
  let acted = false;
  const onLog = ({ id, line }) => {
    if (id !== instance.id || acted || !line.includes("Attempting to create local directory")) return;
    acted = true;
    during(existsSync(join(confDir, "sync_list.discovery-backup")));
  };
  env.supervisor.events.on("log", onLog);
  const ended = new Promise((resolve) => {
    const onRun = ({ id, running }) => {
      if (id !== instance.id || running) return;
      discovery.events.off("discovery", onRun);
      resolve();
    };
    discovery.events.on("discovery", onRun);
  });
  discovery.start(instance);
  await ended;
  env.supervisor.events.off("log", onLog);
  assert.equal(acted, true, "the action ran while the dry run was going");
}

test("a selection saved during a run is what the account has afterwards", async () => {
  env.synclist.write(instance, "/Old/\n");
  assert.equal(readFileSync(join(confDir, "sync_list"), "utf8").trim(), "/Old/");

  let parkedDuringRun = null;
  await duringDryRun((parked) => {
    parkedDuringRun = parked;
    env.synclist.write(instance, "/New/\n");
  });
  // The run had the selection: the live file was out of the way.
  assert.equal(parkedDuringRun, true, "the dry run parked the selection");

  assert.equal(discovery.isRunning(instance.id), false, "the run finished");
  assert.equal(
    readFileSync(join(confDir, "sync_list"), "utf8").trim(),
    "/New/",
    "the save survived the run"
  );
});

test("clearing during a run also survives it", async () => {
  env.synclist.write(instance, "/Something/\n");
  await duringDryRun(() => env.synclist.write(instance, "# nothing selected\n"));
  assert.equal(existsSync(join(confDir, "sync_list")), false, "the list is gone, not restored");
});

