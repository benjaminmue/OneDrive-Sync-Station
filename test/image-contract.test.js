// Things about the image that the client silently depends on.
//
// These cannot be exercised without building and running the image, but they
// are one-line mistakes with expensive, invisible consequences, so the file
// that declares them is checked instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dockerfile = readFileSync(fileURLToPath(new URL("../Dockerfile", import.meta.url)), "utf8");

test("the entrypoint sits at /entrypoint.sh, where the client looks for it", () => {
  // The client treats a --syncdir differing from its config file as a change
  // requiring a resync, unless it believes it runs in a container, which it
  // decides purely from the existence of /entrypoint.sh (util.d,
  // entrypointExists). Any other path costs every account a full resync on
  // every single container start, and nothing in the logs points at the cause.
  assert.match(dockerfile, /COPY docker-entrypoint\.sh \/entrypoint\.sh/);
  assert.match(dockerfile, /ENTRYPOINT \["\/entrypoint\.sh"\]/);
});

test("the entrypoint is executable and a command follows it", () => {
  assert.match(dockerfile, /chmod \+x \/entrypoint\.sh/);
  // Without a CMD the entrypoint receives no arguments and a plain `docker run
  // image onedrive --version` hangs instead of answering, which cost an hour of
  // CI time once.
  assert.match(dockerfile, /CMD \["node", "src\/server\.js"\]/);
});
