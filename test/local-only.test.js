// Folders that exist on this server but not in OneDrive.
//
// A folder created here, outside the selection, is never uploaded, and the
// client says nothing about it when it holds no files. The listing therefore
// has to tell the two apart. The risk this covers is the silent inverse: if the
// path shapes of the sources ever drift, every folder would be reported as
// local-only and the warning would become noise nobody reads.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "./helpers.mjs";

let env;
let foldertree;
let instance;

/**
 * Look a folder up by name anywhere in the tree.
 * @param {object[]} nodes Tree to search.
 * @param {string} name Folder name.
 * @returns {object|null} The node, or null.
 */
function find(nodes, name) {
  for (const node of nodes) {
    if (node.name === name) return node;
    const hit = find(node.children, name);
    if (hit) return hit;
  }
  return null;
}

before(async () => {
  env = await bootstrap();
  foldertree = await import("../src/foldertree.js");
  instance = env.instances.createInstance({ name: "Mixed Account", type: "personal" });

  // Known online, reported by a discovery run.
  writeFileSync(
    join(env.config.instanceConfDir(instance.id), "discovered-folders.json"),
    JSON.stringify({ at: "2026-08-26T00:00:00Z", folders: ["Apfelbaum", "Apfelbaum/Birnenbaum"] })
  );

  // On disk: one that is also online, one that only exists here.
  const data = env.config.instanceDataDir(instance.folder);
  mkdirSync(join(data, "Apfelbaum", "Birnenbaum"), { recursive: true });
  mkdirSync(join(data, "Birne"), { recursive: true });
});

after(() => env.cleanup());

test("a folder known online is not reported as local-only", () => {
  const res = foldertree.readFolderTree(instance);
  assert.equal(res.available, true);

  const apfelbaum = find(res.folders, "Apfelbaum");
  assert.ok(apfelbaum, "the folder is listed");
  assert.equal(apfelbaum.localOnly, false);

  // Nested too, so the check is not accidentally passing at the top level only.
  assert.equal(find(res.folders, "Birnenbaum").localOnly, false);
});

test("a folder that exists only here is marked", () => {
  const res = foldertree.readFolderTree(instance);
  const birne = find(res.folders, "Birne");
  assert.ok(birne, "the local folder is listed at all");
  assert.equal(birne.localOnly, true);
});

test("the flag is set on every node, never left undefined", () => {
  const res = foldertree.readFolderTree(instance);
  const walk = (nodes) => {
    for (const node of nodes) {
      assert.equal(typeof node.localOnly, "boolean", `${node.path} has no flag`);
      walk(node.children);
    }
  };
  walk(res.folders);
});

test("with no online source, nothing is claimed to be local-only", async () => {
  // Seen in real use: the client held its database lock, every online source
  // came back empty, and the list then marked folders that had just been
  // downloaded from SharePoint as existing only on this server.
  const bare = env.instances.createInstance({ name: "Bare Account", type: "personal" });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(env.config.instanceDataDir(bare.folder), "Downloaded"), { recursive: true });

  const res = foldertree.readFolderTree(bare);
  assert.equal(res.available, true, "the local folders are still listed");
  assert.equal(find(res.folders, "Downloaded").localOnly, false, "but nothing is claimed");
});
