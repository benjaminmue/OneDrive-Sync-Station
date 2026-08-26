// A damaged account registry must stop the station rather than present itself
// as "no accounts configured".
//
// Its own file because the config paths are captured when config.js is first
// imported, and instances.js resolves that same cached module: pointing the
// environment at a prepared directory only works in a process where nothing
// has been imported yet.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "odss-corrupt-"));
const configDir = join(root, "config");

let instances;

before(async () => {
  mkdirSync(configDir, { recursive: true });
  // Exactly what an interrupted write leaves behind.
  writeFileSync(join(configDir, "instances.json"), '{"instances": [{"id": "work-acc');

  process.env.CONFIG_DIR = configDir;
  process.env.DATA_DIR = join(root, "data");
  instances = await import("../src/instances.js");
});

after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

test("a corrupt registry is refused instead of hiding every account", () => {
  // Continuing with an empty list would invite the user to create the accounts
  // again, leaving the existing config directories, sign-ins and item databases
  // behind unreferenced.
  assert.throws(
    () => instances.listInstances(),
    (err) => /not valid JSON/.test(err.message) && /empty account list/.test(err.message)
  );
});

test("the error names the file and says the synced data is safe", () => {
  try {
    instances.listInstances();
    assert.fail("expected a throw");
  } catch (err) {
    assert.match(err.message, /instances\.json/);
    assert.match(err.message, /synced data is not affected/);
  }
});
