// The folder listing, read from the sync client's own item database.
//
// The database belongs to the client, not to this project, so the tests cover
// both halves of that bargain: the tree is built correctly from the schema as
// it is today, and every way the read can fail degrades to "no list" instead of
// breaking the folder selection.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootstrap } from "./helpers.mjs";

// Imported through bootstrap, not statically: a static import would load
// config.js before the temporary paths are in the environment, and the module
// captures them once.

let env;
let foldertree;
let instance;

/**
 * Create an item database in the shape the client writes.
 * @param {string} file Path of the database to create.
 * @param {Array<{id: string, name: string, type: string, parentId: string|null}>} items Rows to insert.
 * @returns {void}
 */
function writeItemDatabase(file, items) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE item (
    driveId TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, remoteName TEXT,
    type TEXT NOT NULL, eTag TEXT, cTag TEXT, mtime TEXT NOT NULL, parentId TEXT,
    quickXorHash TEXT, sha256Hash TEXT, remoteDriveId TEXT, remoteParentId TEXT,
    remoteId TEXT, remoteType TEXT, deltaLink TEXT, syncStatus TEXT, size TEXT,
    relocDriveId TEXT, relocParentId TEXT, PRIMARY KEY (driveId, id))`);
  const insert = db.prepare(
    "INSERT INTO item (driveId, id, name, type, mtime, parentId) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const item of items) {
    insert.run("drive1", item.id, item.name, item.type, "2026-08-26T00:00:00Z", item.parentId);
  }
  db.close();
}

before(async () => {
  env = await bootstrap();
  foldertree = await import("../src/foldertree.js");
  instance = env.instances.createInstance({ name: "Tree Account", type: "personal" });
});

after(() => env.cleanup());

test("an account that never synced reports no list rather than an error", () => {
  const res = foldertree.readFolderTree(instance);
  assert.equal(res.available, false);
  assert.equal(res.reason, "not-synced-yet");
  assert.deepEqual(res.folders, []);
});

test("folders are nested by parent and sorted by name", () => {
  writeItemDatabase(join(env.root, "config", "instances", instance.id, "items.sqlite3"), [
    { id: "root", name: "root", type: "dir", parentId: null },
    { id: "pics", name: "Pictures", type: "dir", parentId: "root" },
    { id: "docs", name: "Documents", type: "dir", parentId: "root" },
    { id: "proj", name: "Projects", type: "dir", parentId: "docs" },
    { id: "note", name: "notes.txt", type: "file", parentId: "docs" },
  ]);

  const res = foldertree.readFolderTree(instance);
  assert.equal(res.available, true);

  // The client's own root item is the single top level entry; everything the
  // user recognises hangs below it.
  const top = res.folders[0].children;
  assert.deepEqual(top.map((node) => node.name), ["Documents", "Pictures"]);
  assert.equal(top[0].children[0].name, "Projects");
});

test("files are left out, only folders can be selected", () => {
  const res = foldertree.readFolderTree(instance);
  const names = [];
  const walk = (nodes) => nodes.forEach((node) => (names.push(node.name), walk(node.children)));
  walk(res.folders);
  assert.ok(!names.includes("notes.txt"));
});

test("paths are absolute, which is what a sync_list rule needs", () => {
  const res = foldertree.readFolderTree(instance);
  const docs = res.folders[0].children.find((node) => node.name === "Documents");
  assert.equal(docs.path, "/root/Documents");
  assert.equal(docs.children[0].path, "/root/Documents/Projects");
});

test("remote items count as folders, shared shortcuts are selectable", () => {
  const rows = [
    { id: "a", name: "Shared", type: "remote", parentId: null },
    { id: "b", name: "Inside", type: "dir", parentId: "a" },
  ];
  const tree = foldertree.buildTree(rows.map((row) => ({ ...row, parentId: row.parentId })));
  assert.equal(tree[0].name, "Shared");
  assert.equal(tree[0].children[0].path, "/Shared/Inside");
});

test("an orphaned folder still appears instead of vanishing", () => {
  // The client may know a folder whose parent it never recorded. Dropping it
  // would hide a selectable folder with no way for the user to notice.
  const tree = foldertree.buildTree([{ id: "x", name: "Orphan", type: "dir", parentId: "missing" }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].path, "/Orphan");
});

test("a damaged database degrades to no list, not to an exception", () => {
  const file = join(env.root, "config", "instances", instance.id, "items.sqlite3");
  writeFileSync(file, "this is not a database");
  const res = foldertree.readFolderTree(instance);
  assert.equal(res.available, false);
  assert.equal(res.reason, "unreadable");
  assert.deepEqual(res.folders, []);
});

test("an empty item cache falls back to the folders on disk", () => {
  // The client clears its cache on a resync and refills it as it goes. A
  // listing taken in between must not tell the user their account is empty.
  const other = env.instances.createInstance({ name: "Local Fallback", type: "personal" });
  writeItemDatabase(join(env.root, "config", "instances", other.id, "items.sqlite3"), []);
  mkdirSync(join(env.root, "data", other.folder, "Dokumente", "Projekte"), { recursive: true });
  mkdirSync(join(env.root, "data", other.folder, ".hidden"), { recursive: true });

  const res = foldertree.readFolderTree(other);
  assert.equal(res.available, true);
  assert.equal(res.source, "local-files");
  assert.deepEqual(res.folders.map((node) => node.name), ["Dokumente"]);
  assert.equal(res.folders[0].children[0].path, "/Dokumente/Projekte");
});

test("a damaged cache falls back too, rather than showing nothing", () => {
  const other = env.instances.createInstance({ name: "Broken Cache", type: "personal" });
  writeFileSync(
    join(env.root, "config", "instances", other.id, "items.sqlite3"),
    "not a database"
  );
  mkdirSync(join(env.root, "data", other.folder, "Bilder"), { recursive: true });

  const res = foldertree.readFolderTree(other);
  assert.equal(res.available, true);
  assert.equal(res.source, "local-files");
  assert.deepEqual(res.folders.map((node) => node.name), ["Bilder"]);
});
