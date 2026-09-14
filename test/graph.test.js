// Reading the folder tree from Microsoft Graph instead of a client dry run.
//
// Everything runs against a loopback stand-in for the token endpoint and the
// delta API. What matters most here is what never happens: the client's token
// file is not rewritten, no token reaches a log, and no request leaves for a
// host the station did not choose.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap, waitFor } from "./helpers.mjs";
import { startFakeGraph } from "./fixtures/fake-graph.mjs";

let fake;
let env;
let graph;
let discovery;

const root = { id: "root-id", name: "root", root: {}, folder: {} };
const folder = (id, name, parentId, extra = {}) => ({ id, name, folder: {}, parentReference: { id: parentId }, ...extra });
const file = (id, name, parentId) => ({ id, name, file: {}, parentReference: { id: parentId } });

/**
 * Create a signed-in account.
 * @param {object} input createInstance input.
 * @returns {object} The instance.
 */
function signedIn(input) {
  const instance = env.instances.createInstance(input);
  writeFileSync(env.instances.refreshTokenPath(instance), "the-refresh-token\n");
  return instance;
}

before(async () => {
  fake = await startFakeGraph();
  env = await bootstrap({ graphBase: fake.base });
  graph = await import("../src/graph.js");
  discovery = await import("../src/discovery.js");
});

beforeEach(() => fake.reset());

after(async () => {
  await discovery.stopAll();
  await fake.close();
  env.cleanup();
});

/**
 * Feed raw delta items through the same reduction listFolders applies.
 * @param {object[]} raw Delta items in arrival order.
 * @returns {{folders: string[], remote: string[]}} The paths.
 */
function pathsOf(raw) {
  const items = new Map();
  for (const item of raw) {
    const slim = item.deleted ? null : graph.treeItem(item);
    if (slim) items.set(item.id, slim);
    else items.delete(item.id);
  }
  return graph.folderPaths(items);
}

test("paths are built from parent ids, whatever order the items arrive in", () => {
  const result = pathsOf([
    folder("c", "Paris", "b"), // child before its parent
    folder("b", "Bilder", "root-id"),
    root,
    file("f", "photo.jpg", "c"),
    folder("d", "Old", "root-id"),
    folder("d", "Renamed", "root-id"), // later occurrence wins
    folder("e", "Gone", "root-id"),
    folder("g", "Inside gone", "e"),
    folder("e", "Gone", "root-id", { deleted: {} }), // deleted after it was seen
    folder("h", "Orphan", "missing-parent"),
    { id: "p", name: "Notebook", package: { type: "oneNote" }, parentReference: { id: "root-id" } },
    folder("q", "In a notebook", "p"),
    folder("x", "Loop A", "y"),
    folder("y", "Loop B", "x"),
    { id: "s", name: "Shared with me", remoteItem: { folder: {} }, parentReference: { id: "root-id" } },
  ]);

  assert.deepEqual(result.folders, ["Bilder", "Bilder/Paris", "Renamed", "Shared with me"]);
  assert.deepEqual(result.remote, ["Shared with me"]);
});

test("a personal account is listed from its own drive, across pages", async () => {
  const instance = signedIn({ name: "Private", type: "personal" });
  fake.script.pages = [
    [root, folder("b", "Bilder", "root-id")],
    [folder("p", "Paris Oct. 2021", "b"), file("x", "x.jpg", "p")],
  ];

  const result = await graph.listFolders(instance);
  assert.deepEqual(result.folders, ["Bilder", "Bilder/Paris Oct. 2021"]);
  assert.equal(result.pages, 2);

  const [token, first, second] = fake.requests;
  assert.equal(token.path, "/common/oauth2/v2.0/token");
  const form = new URLSearchParams(token.body);
  assert.equal(form.get("client_id"), graph.DEFAULT_APPLICATION_ID);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "the-refresh-token");
  // The client's own refresh request: its redirect URI and no scope.
  assert.equal(form.get("redirect_uri"), `${fake.base}/common/oauth2/nativeclient`);
  assert.equal(form.has("scope"), false);

  assert.equal(first.path, "/v1.0/me/drive/root/delta");
  assert.match(decodeURIComponent(first.query), /\$select=id,name,folder,remoteItem,parentReference,deleted,root/);
  assert.equal(first.headers.authorization, "Bearer fake-access-token");
  assert.equal(second.query, "?page=1");

  // Microsoft handed back a new refresh token. The client's file keeps its own.
  assert.equal(readFileSync(env.instances.refreshTokenPath(instance), "utf8"), "the-refresh-token\n");
});

test("a SharePoint library is listed from its drive id", async () => {
  const instance = signedIn({ name: "Library", type: "sharepoint", driveId: "b!Abc-123_x" });
  fake.script.pages = [[root, folder("i", "images", "root-id")]];

  const result = await graph.listFolders(instance);
  assert.deepEqual(result.folders, ["images"]);
  assert.equal(fake.requests[1].path, "/v1.0/drives/b!Abc-123_x/root/delta");
});

test("an account with its own app registration signs in with it", async () => {
  const instance = signedIn({
    name: "Tenant Business",
    type: "business",
    options: {
      applicationId: "11111111-2222-3333-4444-555555555555",
      azureTenantId: "contoso.onmicrosoft.com",
    },
  });
  fake.script.pages = [[root]];

  await graph.listFolders(instance);
  assert.equal(fake.requests[0].path, "/contoso.onmicrosoft.com/oauth2/v2.0/token");
  const form = new URLSearchParams(fake.requests[0].body);
  assert.equal(form.get("client_id"), "11111111-2222-3333-4444-555555555555");
  assert.equal(form.get("redirect_uri"), `${fake.base}/contoso.onmicrosoft.com/oauth2/nativeclient`);
});

test("a next link to another host is refused, not followed", async () => {
  const instance = signedIn({ name: "Redirected", type: "business" });
  fake.script.pages = [[root], [root]];
  fake.script.nextLink = () => "https://attacker.example/v1.0/me/drive/root/delta?page=1";
  await assert.rejects(graph.listFolders(instance), (err) => err.reason === "unexpected-link");
  assert.equal(fake.requests.length, 2, "the token request and the first page, nothing more");
});

test("a throttled request is retried", async () => {
  const instance = signedIn({ name: "Throttled", type: "personal" });
  fake.script.pages = [[root, folder("a", "Anlagen", "root-id")]];
  fake.script.throttleFirst = 2;

  const result = await graph.listFolders(instance);
  assert.deepEqual(result.folders, ["Anlagen"]);
  const deltas = fake.requests.filter((r) => r.path.endsWith("/root/delta"));
  assert.equal(deltas.length, 3, "two throttled attempts, then the answer");
});

test("an access token that expires mid-listing is renewed once", async () => {
  const instance = signedIn({ name: "Long Listing", type: "personal" });
  fake.script.pages = [[root, folder("a", "Anlagen", "root-id")], [folder("b", "Bilder", "root-id")]];
  fake.script.expireOnPage = 1;

  const result = await graph.listFolders(instance);
  assert.deepEqual(result.folders, ["Anlagen", "Bilder"]);
  assert.equal(fake.requests.filter((r) => r.path.endsWith("/token")).length, 2);
});

test("a listing without the drive root is refused rather than stored as empty", async () => {
  const instance = signedIn({ name: "Rootless", type: "business" });
  fake.script.pages = [[folder("a", "Anlagen", "somewhere")]];
  await assert.rejects(graph.listFolders(instance), (err) => err.reason === "no-root");
});

test("with skip_dotfiles, dot folders are not offered", async () => {
  const instance = signedIn({ name: "Dotless", type: "personal", options: { skipDotfiles: true } });
  fake.script.pages = [[root, folder("g", ".git", "root-id"), folder("c", "Code", "root-id"), folder("h", ".hidden", "c")]];
  const result = await graph.listFolders(instance);
  assert.deepEqual(result.folders, ["Code"]);
});

test("a refused token is reported by its error code only", async () => {
  const instance = signedIn({ name: "Refused", type: "personal" });
  fake.script.token = {
    status: 400,
    body: { error: "invalid_grant", error_description: "AADSTS70000: token the-refresh-token is bad" },
  };
  await assert.rejects(graph.listFolders(instance), (err) => {
    assert.equal(err.reason, "token-refused");
    assert.equal(err.message, "token-refused: invalid_grant");
    return true;
  });
});

test("discovery reads Graph, stores a complete listing and leaves the client alone", async () => {
  const instance = signedIn({ name: "Fast", type: "business" });
  env.synclist.write(instance, "/Scans/\n");
  fake.script.pages = [[root, folder("s", "Scans", "root-id"), folder("b", "Bilder", "root-id")]];

  env.supervisor.start(instance);
  assert.ok(await waitFor(() => env.supervisor.status(instance.id).running), "the client runs");
  const pid = env.supervisor.status(instance.id).pid;

  discovery.start(instance);
  assert.ok(await waitFor(() => !discovery.isRunning(instance.id)), "the run ended");

  const stored = JSON.parse(
    readFileSync(join(env.config.instanceConfDir(instance.id), "discovered-folders.json"), "utf8")
  );
  assert.equal(stored.complete, true);
  assert.deepEqual(stored.folders, ["Bilder", "Scans"]);
  assert.equal(env.supervisor.status(instance.id).pid, pid, "the same client kept running");

  const lines = env.supervisor.logs(instance.id).map((entry) => entry.line);
  assert.ok(lines.some((line) => /read 2 folders from Microsoft Graph/.test(line)));
  assert.ok(!lines.some((line) => line.includes("DRY-RUN")), "no dry run");
  assert.ok(!lines.some((line) => /fake-access-token|the-refresh-token/.test(line)), "no token in the log");
  await env.supervisor.stop(instance.id);
});

test("when Graph fails, discovery holds the client for the dry run and resumes it", async () => {
  const instance = signedIn({ name: "Fallback", type: "personal" });
  env.synclist.write(instance, "/Bilder/\n");
  fake.script.token = { status: 401, body: { error: "unauthorized_client" } };

  env.supervisor.start(instance);
  assert.ok(await waitFor(() => env.supervisor.status(instance.id).running), "the client runs");

  let ranDuringDryRun = false;
  const sample = ({ id, line }) => {
    if (id === instance.id && line.includes("Attempting to create local directory")) {
      ranDuringDryRun = ranDuringDryRun || env.supervisor.status(instance.id).running;
    }
  };
  env.supervisor.events.on("log", sample);
  // As after a sign-in: no help from the caller, the run pauses the client itself.
  discovery.start(instance);
  assert.ok(await waitFor(() => !discovery.isRunning(instance.id), 15_000), "the run ended");
  env.supervisor.events.off("log", sample);

  const lines = env.supervisor.logs(instance.id).map((entry) => entry.line);
  assert.ok(lines.some((line) => /Microsoft Graph could not list the folders \(token-refused: unauthorized_client\)/.test(line)));
  assert.ok(lines.some((line) => line.includes("DRY-RUN")), "the dry run took over");
  assert.equal(ranDuringDryRun, false, "the client was stopped while the dry run ran");
  assert.ok(await waitFor(() => env.supervisor.status(instance.id).running), "the client was resumed");

  const stored = JSON.parse(
    readFileSync(join(env.config.instanceConfDir(instance.id), "discovered-folders.json"), "utf8")
  );
  assert.equal(stored.complete, false, "a dry run never counts as a complete listing");
  await env.supervisor.stop(instance.id);
});

test("a dry run after a failed Graph run adds to a complete listing instead of replacing it", async () => {
  const instance = signedIn({ name: "Kept Complete", type: "business" });
  const listingFile = join(env.config.instanceConfDir(instance.id), "discovered-folders.json");

  fake.script.pages = [[root, folder("a", "Anlagen", "root-id"), { id: "s", name: "Geteilt", remoteItem: { folder: {} }, parentReference: { id: "root-id" } }]];
  discovery.start(instance);
  assert.ok(await waitFor(() => !discovery.isRunning(instance.id)));

  fake.script.token = { status: 400, body: { error: "invalid_grant" } };
  discovery.start(instance);
  assert.ok(await waitFor(() => !discovery.isRunning(instance.id), 15_000));

  const stored = JSON.parse(readFileSync(listingFile, "utf8"));
  assert.equal(stored.complete, true);
  assert.deepEqual(stored.remote, ["Geteilt"]);
  // The stub dry run names Scans, Bilder and Bilder/Paps.
  assert.deepEqual([...stored.folders].sort(), ["Anlagen", "Bilder", "Bilder/Paps", "Geteilt", "Scans"]);
});

test("a selection saved during a Graph run is not swallowed by a leftover parked copy", async () => {
  const instance = signedIn({ name: "Leftover", type: "personal" });
  const confDir = env.config.instanceConfDir(instance.id);
  // What a crash between parking and restoring leaves behind.
  writeFileSync(join(confDir, "sync_list.discovery-backup"), "/Old/\n");
  fake.script.pages = [[root]];

  discovery.start(instance);
  env.synclist.write(instance, "/New/\n");
  assert.ok(await waitFor(() => !discovery.isRunning(instance.id)));

  assert.equal(readFileSync(join(confDir, "sync_list"), "utf8").trim(), "/New/");
});
