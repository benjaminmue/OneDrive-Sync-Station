// Input validation, the single place that decides what may reach the
// filesystem, a process argument or the client config file.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as validate from "../src/validate.js";
import { ValidationError } from "../src/validate.js";

/** A NUL byte, written explicitly so the test source stays plain ASCII. */
const NUL = String.fromCharCode(0);

/**
 * Assert that a validator rejects a value.
 * @param {() => unknown} fn Call under test.
 * @param {string} reason Expected machine readable reason.
 */
function rejects(fn, reason) {
  assert.throws(fn, (err) => err instanceof ValidationError && err.reason === reason);
}

test("slug accepts filesystem-safe names", () => {
  assert.equal(validate.slug("work-business"), "work-business");
  assert.equal(validate.slug("a"), "a");
});

test("slug rejects path traversal and separators", () => {
  rejects(() => validate.slug(".."), "invalid-slug");
  rejects(() => validate.slug("../etc/passwd"), "invalid-slug");
  rejects(() => validate.slug("a/b"), "invalid-slug");
  rejects(() => validate.slug("a\\b"), "invalid-slug");
  rejects(() => validate.slug(".hidden"), "invalid-slug");
  rejects(() => validate.slug("UPPER"), "invalid-slug");
  rejects(() => validate.slug("-leading"), "invalid-slug");
  rejects(() => validate.slug("x".repeat(49)), "invalid-slug");
});

test("slugify derives a usable slug from a display name", () => {
  assert.equal(validate.slugify("Work Business"), "work-business");
  assert.equal(validate.slugify("  Büro / Archiv  "), "buro-archiv");
  assert.equal(validate.slugify("../.."), "");
});

test("displayName rejects control characters", () => {
  assert.equal(validate.displayName(" Work Business "), "Work Business");
  rejects(() => validate.displayName("a" + NUL + "b"), "invalid-characters");
  rejects(() => validate.displayName("line\nbreak"), "invalid-characters");
  rejects(() => validate.displayName(""), "required");
});

test("configValue blocks breaking out of the key = \"value\" form", () => {
  assert.equal(validate.configValue("~*|.~*|*.tmp", "skipFile"), "~*|.~*|*.tmp");
  rejects(() => validate.configValue('a"b', "skipFile"), "invalid-characters");
  rejects(() => validate.configValue('x\nsync_dir = "/etc"', "skipFile"), "invalid-characters");
  rejects(() => validate.configValue("back\\slash", "skipFile"), "invalid-characters");
});

test("remotePath refuses values that would read as another client flag", () => {
  assert.equal(validate.remotePath("Documents/Projects"), "Documents/Projects");
  rejects(() => validate.remotePath("--resync"), "invalid-characters");
  rejects(() => validate.remotePath("a/../../etc"), "path-traversal");
  rejects(() => validate.remotePath("a" + NUL + "b"), "invalid-characters");
});

test("driveId accepts real ids and rejects anything else", () => {
  assert.equal(validate.driveId("b!Ab-c_1.2=="), "b!Ab-c_1.2==");
  rejects(() => validate.driveId("b!abc def"), "invalid-characters");
  rejects(() => validate.driveId("b!abc;rm -rf /"), "invalid-characters");
});

test("authResponseUrl only accepts a Microsoft redirect carrying a code", () => {
  const good = "https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc";
  assert.equal(validate.authResponseUrl(good), good);
  rejects(() => validate.authResponseUrl("https://evil.example.com/?code=abc"), "unexpected-host");
  rejects(
    () => validate.authResponseUrl("https://login.microsoftonline.com/common/oauth2/nativeclient"),
    "missing-code"
  );
  rejects(() => validate.authResponseUrl("not a url"), "not-a-url");
  rejects(
    () => validate.authResponseUrl("javascript:alert(1)//login.microsoftonline.com?code=1"),
    "invalid-scheme"
  );
});

test("syncListText normalises line endings and keeps rule syntax", () => {
  const text = validate.syncListText("/Docs/\r\n!/Docs/temp*\r\n\n");
  assert.equal(text, "/Docs/\n!/Docs/temp*\n");
});

test("syncListText rejects oversized input and control characters", () => {
  rejects(() => validate.syncListText("a" + NUL + "b"), "invalid-characters");
  rejects(() => validate.syncListText("x".repeat(64 * 1024 + 1)), "too-large");
  rejects(() => validate.syncListText("a\n".repeat(2001)), "too-many-lines");
});

test("integer enforces its range", () => {
  assert.equal(validate.integer("300", { field: "monitorInterval", min: 300, max: 86400 }), 300);
  rejects(
    () => validate.integer("299", { field: "monitorInterval", min: 300, max: 86400 }),
    "out-of-range"
  );
  rejects(() => validate.integer("abc", { field: "threads", min: 1, max: 16 }), "not-an-integer");
});

test("password enforces a minimum length", () => {
  assert.equal(validate.password("longenough"), "longenough");
  rejects(() => validate.password("short"), "invalid-length");
  rejects(() => validate.password(""), "required");
});
