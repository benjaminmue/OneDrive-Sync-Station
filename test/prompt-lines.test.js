// The sign-in prompt is recognised on complete lines only.
//
// Found by the Codex review: pipe chunks end anywhere, and matching a chunk
// took the rest of an ordinary file name for the start of a line, which would
// have stopped a healthy sync.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promptLineWatcher } from "../src/supervisor.js";

test("a prompt line is recognised, also when it arrives in pieces", () => {
  const isPrompt = promptLineWatcher();
  assert.equal(isPrompt("RefreshToken file exists but is empty: /config/instances/a/refresh_token\n"), true);

  const pieces = promptLineWatcher();
  assert.equal(pieces("Please authorise this application by vis"), false, "not complete yet");
  assert.equal(pieces("iting the following URL:\n"), true);

  const pending = promptLineWatcher();
  assert.equal(pending("[14m 53s remaining] Still pending authorisation ...\r\n"), true);
});

test("a file name split before a prompt phrase is not a prompt", () => {
  const isPrompt = promptLineWatcher();
  assert.equal(isPrompt("Downloading file: Notes/"), false);
  assert.equal(isPrompt("Please authorise this application by visiting the following URL.txt ... done\n"), false);
  assert.equal(isPrompt("Uploading file: ./[14m 59s remaining] Still pending authorisation ...\n"), false);
});

test("the tail of an overlong line is not taken for a line start", () => {
  const isPrompt = promptLineWatcher();
  assert.equal(isPrompt("x".repeat(5000)), false);
  assert.equal(isPrompt("RefreshToken file exists but is empty: tail of the long line\n"), false);
  assert.equal(isPrompt("RefreshToken file exists but is empty: a real line\n"), true);
});
