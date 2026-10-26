// The log view's "hide routine lines" rule.
//
// The client's integrity check prints every unchanged item on two lines, a
// "Processing:" line and its verdict, which on a photo library buries the few
// lines worth reading. Only pairs whose verdict is "has not changed" may go: an
// item that did change, and local files left behind, must stay visible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hideRoutine, routineLineFilter, isSkipNoise } from "../public/logfilter.js";

const entries = (...lines) => lines.map((line, i) => ({ ts: String(i), line }));
const linesOf = (list) => list.map((e) => e.line);

test("unchanged pairs and skipped remote paths are hidden", () => {
  const shown = hideRoutine(
    entries(
      "Starting a sync with Microsoft OneDrive",
      "Processing: _Archive/18. Random Basel/20250720_233754482_iOS.jpg",
      "The file has not changed",
      "Processing: _Archive",
      "The directory has not changed",
      "Skipping path - excluded by sync_list config: ./Other",
      "Sync with Microsoft OneDrive is complete"
    )
  );
  assert.deepEqual(linesOf(shown), [
    "Starting a sync with Microsoft OneDrive",
    "Sync with Microsoft OneDrive is complete",
  ]);
});

test("an item that changed keeps both lines, and local skips stay", () => {
  const shown = hideRoutine(
    entries(
      "Processing: Scans/report.pdf",
      "The file has changed",
      "Skipping file - excluded by sync_list config: /data/a/local.txt"
    )
  );
  assert.equal(shown.length, 3);
  assert.equal(isSkipNoise("Skipping file - excluded by sync_list config: x"), false);
});

test("a Processing line at the very end is kept, its verdict is not known yet", () => {
  assert.deepEqual(linesOf(hideRoutine(entries("Processing: a.jpg"))), ["Processing: a.jpg"]);
});

test("the live filter holds a Processing line back and decides on the next one", () => {
  const filter = routineLineFilter();
  const feed = (line) => linesOf(filter({ line }));

  assert.deepEqual(feed("Processing: a.jpg"), [], "held back");
  assert.deepEqual(feed("The file has not changed"), [], "pair dropped");

  assert.deepEqual(feed("Processing: b.jpg"), []);
  assert.deepEqual(feed("Uploading new file: b.jpg ... done"), [
    "Processing: b.jpg",
    "Uploading new file: b.jpg ... done",
  ], "released with the line that decided it");

  assert.deepEqual(feed("Skipping path - excluded by sync_list config: ./x"), []);
  assert.deepEqual(feed("Sync with Microsoft OneDrive is complete"), ["Sync with Microsoft OneDrive is complete"]);
});

test("the live filter and the buffered filter agree", () => {
  const sample = entries(
    "Processing: a",
    "The directory has not changed",
    "Processing: b",
    "The file has changed",
    "Processing: c",
    "Processing: d",
    "The file has not changed",
    "done"
  );
  const filter = routineLineFilter();
  const live = sample.flatMap((e) => filter(e));
  assert.deepEqual(linesOf(live), linesOf(hideRoutine(sample)));
});
