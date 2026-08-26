// Client wrapper: argument construction and the tolerant parsing of the
// human readable client output.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { bootstrap, FAKE_CLIENT } from "./helpers.mjs";

let env;
let instance;

before(async () => {
  env = await bootstrap();
  instance = env.instances.createInstance({ name: "Business", type: "business" });
});

after(() => env.cleanup());

test("baseArgs pins the config and data directory of the instance", () => {
  const args = env.onedrive.baseArgs(instance);
  assert.deepEqual(args, [
    "--confdir",
    join(env.root, "config", "instances", "business"),
    "--syncdir",
    join(env.root, "data", "business"),
  ]);
});

test("clientCommand runs a Node stub through Node and a binary directly", () => {
  const viaNode = env.onedrive.clientCommand(["--version"]);
  assert.equal(viaNode.command, process.execPath);
  assert.deepEqual(viaNode.args, [FAKE_CLIENT, "--version"]);
});

test("the client is reachable and reports a version", async () => {
  const res = await env.onedrive.version();
  assert.equal(res.ok, true);
  assert.match(res.text, /onedrive v/);
});

test("a failing command reports ok false instead of throwing", async () => {
  const res = await env.onedrive.run(["--not-a-real-flag"]);
  assert.equal(res.ok, false);
  assert.match(res.text, /unhandled arguments/);
});

test("SharePoint output is parsed into libraries", () => {
  const text = [
    "Library Name = Marketing Documents",
    'drive_id = "b!ABC123"',
    "",
    "Library Name = Marketing Archive",
    "drive_id = b!DEF456",
  ].join("\n");

  assert.deepEqual(env.onedrive.parseSharePointDriveIds(text), [
    { name: "Marketing Documents", driveId: "b!ABC123" },
    { name: "Marketing Archive", driveId: "b!DEF456" },
  ]);
});

test("unrecognised SharePoint output yields no libraries rather than guesses", () => {
  assert.deepEqual(env.onedrive.parseSharePointDriveIds("ERROR: site not found"), []);
});

test("the SharePoint lookup returns both the parsed and the raw result", async () => {
  const res = await env.onedrive.getSharePointDriveId(instance, "Marketing");
  assert.equal(res.ok, true);
  assert.equal(res.libraries.length, 2);
  assert.equal(res.libraries[0].driveId, "b!FAKEDRIVEID123");
  assert.match(res.text, /Library Name/);
});
