// The folder list has to work while the client is running.
//
// The sync client keeps its item database locked, and opening it read-only is
// not enough: the read fails with "database is locked". The list then falls
// back to weaker sources without saying so, shows fewer folders than exist, and
// marks freshly downloaded ones as local-only. Reading from a copy avoids
// contending for the lock at all.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootstrap } from "./helpers.mjs";

let env;
let foldertree;
let instance;
let dbPath;
let holder;

before(async () => {
  env = await bootstrap();
  foldertree = await import("../src/foldertree.js");
  instance = env.instances.createInstance({ name: "Locked", type: "personal" });
  dbPath = join(env.config.instanceConfDir(instance.id), "items.sqlite3");

  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE item (
    driveId TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, remoteName TEXT,
    type TEXT NOT NULL, eTag TEXT, cTag TEXT, mtime TEXT NOT NULL, parentId TEXT,
    quickXorHash TEXT, sha256Hash TEXT, remoteDriveId TEXT, remoteParentId TEXT,
    remoteId TEXT, remoteType TEXT, deltaLink TEXT, syncStatus TEXT, size TEXT,
    relocDriveId TEXT, relocParentId TEXT, PRIMARY KEY (driveId, id))`);
  const insert = db.prepare(
    "INSERT INTO item (driveId, id, name, type, mtime, parentId) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insert.run("d1", "root", "root", "dir", "2026-08-27T00:00:00Z", null);
  insert.run("d1", "arch", "_Archive", "dir", "2026-08-27T00:00:00Z", "root");
  db.close();

  // What the running client does: hold the database with an open write
  // transaction, which is what makes a plain read fail.
  holder = new DatabaseSync(dbPath);
  holder.exec("BEGIN EXCLUSIVE");
});

after(() => {
  try {
    holder.exec("ROLLBACK");
    holder.close();
  } catch {
    // already gone
  }
  env.cleanup();
});

test("folders are listed even while the client holds the database", () => {
  const res = foldertree.readFolderTree(instance);
  assert.equal(res.available, true);
  const names = [];
  const walk = (nodes) => nodes.forEach((n) => (names.push(n.name), walk(n.children)));
  walk(res.folders);
  assert.ok(names.includes("_Archive"), `_Archive is listed, got ${names.join(", ")}`);
});

test("a folder known online is not marked local-only during a lock", () => {
  const res = foldertree.readFolderTree(instance);
  const find = (nodes) => {
    for (const n of nodes) {
      if (n.name === "_Archive") return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return null;
  };
  assert.equal(find(res.folders).localOnly, false);
});

test("no copies are left behind in the config directory", () => {
  foldertree.readFolderTree(instance);
  const leftovers = readdirSync(env.config.instanceConfDir(instance.id))
    .filter((name) => name.includes(".reading-"));
  assert.deepEqual(leftovers, []);
});
