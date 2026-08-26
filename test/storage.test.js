// State files: atomic writes, and the refusal to treat a damaged file as an
// empty one. The latter is a security property, not a convenience: an empty
// settings file puts the station into first-run mode, where anyone who reaches
// the port can set a new password and take over every synced account.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "./helpers.mjs";
import { writeFileAtomic, readJsonFile } from "../src/storage.js";

let env;

before(async () => {
  env = await bootstrap();
});

after(() => env.cleanup());

test("readJsonFile separates missing from corrupt", () => {
  const file = join(env.root, "probe.json");
  assert.equal(readJsonFile(file).status, "missing");

  writeFileSync(file, '{"a":1}');
  const ok = readJsonFile(file);
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.data, { a: 1 });

  // Exactly what a power cut during a write leaves behind.
  writeFileSync(file, '{"a":1');
  assert.equal(readJsonFile(file).status, "corrupt");
});

test("writeFileAtomic leaves no temporary file behind", () => {
  const file = join(env.root, "atomic.txt");
  writeFileAtomic(file, "hello", { mode: 0o600 });
  assert.equal(readFileSync(file, "utf8"), "hello");
  assert.deepEqual(
    readdirSync(env.root).filter((name) => name.endsWith(".tmp")),
    []
  );
});

/**
 * Prepare an isolated config directory holding one damaged state file, then
 * load a fresh copy of a module against it.
 *
 * Both the paths and the parsed state are captured when a module is first
 * imported, so this cannot reuse the modules the other tests hold: the
 * environment has to be pointed at the new directory before the import, and the
 * import needs a unique query string to defeat the module cache.
 *
 * @param {string} fileName State file to damage.
 * @param {string} contents Truncated contents to write.
 * @param {string} modulePath Module to load afterwards.
 * @returns {Promise<{module: object, dir: string}>} The fresh module and its config directory.
 */
async function withDamagedStateFile(fileName, contents, modulePath) {
  const dir = join(env.root, `damaged-${fileName}`);
  const configDir = join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, fileName), contents);

  const previous = process.env.CONFIG_DIR;
  process.env.CONFIG_DIR = configDir;
  const module = await import(`${modulePath}?damaged=${encodeURIComponent(fileName)}`);
  process.env.CONFIG_DIR = previous;
  return { module, dir };
}

test("a corrupt settings file is refused instead of opening first-run mode", async () => {
  const { module } = await withDamagedStateFile(
    "settings.json",
    '{"guiPasswordHash": "trunca',
    "../src/config.js"
  );

  assert.throws(
    () => module.loadSettings(),
    (err) => /not valid JSON/.test(err.message) && /first-run/.test(err.message)
  );
});
