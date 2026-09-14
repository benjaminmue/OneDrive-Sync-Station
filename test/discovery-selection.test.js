// A discovery run has to ignore the folder selection.
//
// The listing exists to show folders that are NOT selected yet, so they can be
// added. Running it with the selection in place would show only what is already
// chosen, which is exactly the state the user is trying to change. The selection
// is therefore moved aside for the run and put back afterwards.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap, waitFor } from "./helpers.mjs";

let env;
let discovery;
let instance;
let confDir;

before(async () => {
  env = await bootstrap();
  discovery = await import("../src/discovery.js");
  instance = env.instances.createInstance({ name: "Selected", type: "business" });
  writeFileSync(env.instances.refreshTokenPath(instance), "token\n");
  confDir = join(env.root, "config", "instances", instance.id);
});

after(async () => {
  discovery.stopAll();
  await env.supervisor.stopAll();
  env.cleanup();
});

test("the selection is put back after a run", async () => {
  const rules = "/Apfelbaum/\n/Unraid syncs/\n";
  env.synclist.write(instance, rules);

  discovery.start(instance);
  const finished = await waitFor(() => !discovery.isRunning(instance.id), 15_000);
  assert.ok(finished, "the run completed");

  // Losing the selection here would silently turn a narrow sync into a full
  // one on the next start, which is the worst possible outcome of a listing.
  assert.equal(env.synclist.read(instance).text, rules);
  assert.equal(existsSync(join(confDir, "sync_list.discovery-backup")), false);
});

test("the client sees no selection while the run is in progress", async () => {
  env.synclist.write(instance, "/Apfelbaum/\n");

  let sawSelectionDuringRun = null;
  // Sampled the moment the dry run prints its first folder, so while the stub
  // client is certainly running: the file must be gone, or the run would list
  // only the folders already selected. Polling would miss a run this short.
  const sample = ({ id, line }) => {
    if (id !== instance.id || sawSelectionDuringRun !== null) return;
    if (line.includes("Attempting to create local directory")) {
      sawSelectionDuringRun = existsSync(join(confDir, "sync_list"));
    }
  };
  env.supervisor.events.on("log", sample);
  discovery.start(instance);
  await waitFor(() => !discovery.isRunning(instance.id), 15_000);
  env.supervisor.events.off("log", sample);

  assert.equal(sawSelectionDuringRun, false);
  assert.equal(env.synclist.read(instance).text, "/Apfelbaum/\n");
});

test("a selection left behind by an interrupted run is recovered", async () => {
  // Simulates a crash between parking and restoring: the backup holds the real
  // selection and must not be treated as expendable.
  writeFileSync(join(confDir, "sync_list.discovery-backup"), "/Rescued/\n");
  const active = join(confDir, "sync_list");
  if (existsSync(active)) writeFileSync(active, "");

  const { rmSync } = await import("node:fs");
  rmSync(active, { force: true });

  discovery.start(instance);
  await waitFor(() => !discovery.isRunning(instance.id), 15_000);

  assert.equal(readFileSync(active, "utf8"), "/Rescued/\n");
});
