// Every string the UI asks for has to exist.
//
// A missing key is not a crash: the lookup returns the key itself, so the user
// reads "app.metaBuild" where a sentence belongs. That shipped once, and it is
// exactly the kind of defect no amount of API testing catches, because the
// server side is perfectly fine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../public/app.js", import.meta.url)),
  "utf8"
);

/**
 * Keys defined in the string table.
 * @returns {Set<string>} Defined keys.
 */
function definedKeys() {
  const start = source.indexOf("export const en = {");
  const table = source.slice(start, source.indexOf("};", start));
  return new Set([...table.matchAll(/^\s{2}"([^"]+)":/gm)].map((match) => match[1]));
}

/**
 * Keys the code looks up through t().
 * @returns {Set<string>} Used keys.
 */
function usedKeys() {
  return new Set([...source.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1]));
}

test("every string the code asks for is defined", () => {
  const defined = definedKeys();
  const missing = [...usedKeys()].filter((key) => !defined.has(key));
  assert.deepEqual(missing, [], `these render as their own key: ${missing.join(", ")}`);
});

test("the string table is not empty, so the check itself cannot pass vacuously", () => {
  assert.ok(definedKeys().size > 50);
  assert.ok(usedKeys().size > 50);
});
