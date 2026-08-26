#!/usr/bin/env node
// Stand-in for the OneDrive client, used by the integration tests.
//
// It implements just enough of the real command line surface to exercise the
// station end to end without a Microsoft account or a container: the file based
// sign-in handshake, monitor mode, and the read-only query commands. Behaviour
// can be steered through environment variables so tests can force failures.
//
//   FAKE_AUTH_FAIL=1     the sign-in exits non-zero instead of succeeding
//   FAKE_NO_AUTH_URL=1   no authorisation URL file is ever written
//   FAKE_MONITOR_EXIT=n  monitor mode exits with code n after a moment

import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);

/**
 * Read the value of a flag from the argument list.
 * @param {string} flag Flag name including dashes.
 * @returns {string|null} The value, or null when the flag is absent.
 */
function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

const has = (flag) => argv.includes(flag);
const confDir = valueOf("--confdir");
const syncDir = valueOf("--syncdir");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (has("--version")) {
  process.stdout.write("onedrive v2.5.11-fake\n");
  process.exit(0);
}

// The file based sign-in: write the authorisation URL, wait for the response
// file, then report success. Mirrors `--auth-files authUrl:responseUrl`.
if (has("--auth-files")) {
  const spec = valueOf("--auth-files") || "";
  // The two paths are separated by a colon. On Windows each path may start with
  // a drive letter that carries a colon of its own, so the separator is the one
  // that is not part of such a prefix. The real client only ever runs on Linux,
  // where the simple case applies; this keeps the stub usable on both.
  const match = spec.match(/^((?:[A-Za-z]:)?[^:]*):((?:[A-Za-z]:)?.*)$/);
  const [urlFile, responseFile] = match ? [match[1], match[2]] : spec.split(":");

  if (process.env.FAKE_NO_AUTH_URL === "1") {
    process.stdout.write("simulated failure: no authorisation url\n");
    await sleep(2000);
    process.exit(1);
  }

  // Mirrors the shape of the real client's authorisation URL, including scope
  // and redirect_uri. It cannot complete a sign-in (the client id is not a real
  // application), but keeping the structure means anyone driving the stub sees
  // the same URL the station will hand out in production, rather than a
  // truncated one that fails with a confusing "missing parameter" error.
  const scope = encodeURIComponent(
    "Files.ReadWrite Files.ReadWrite.All Sites.ReadWrite.All offline_access"
  );
  const redirect = encodeURIComponent("https://login.microsoftonline.com/common/oauth2/nativeclient");
  writeFileSync(
    urlFile,
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize" +
      "?client_id=00000000-0000-0000-0000-00000000fake" +
      `&scope=${scope}&response_type=code&prompt=login&redirect_uri=${redirect}\n`
  );
  process.stdout.write("Waiting for authorisation response\n");

  for (let waited = 0; waited < 60_000; waited += 100) {
    if (existsSync(responseFile) && readFileSync(responseFile, "utf8").trim()) {
      if (process.env.FAKE_AUTH_FAIL === "1") {
        process.stdout.write("Authorisation failed\n");
        process.exit(1);
      }
      // The real client stores its refresh token in the config directory; the
      // station uses the presence of that file as proof of a completed sign-in.
      mkdirSync(confDir, { recursive: true });
      writeFileSync(join(confDir, "refresh_token"), "fake-refresh-token\n");
      process.stdout.write("Authorised. Quota: 1024 MB remaining\n");
      process.exit(0);
    }
    await sleep(100);
  }
  process.exit(1);
}

// Device code flow: the real client prints the verification URL and a code,
// then polls Microsoft by itself until the user confirms. The marker file plays
// the part of the user confirming.
if (process.env.FAKE_DEVICE_AUTH === "1" && has("--display-quota") && !has("--auth-files")) {
  const confirmFile = join(confDir || ".", ".device-confirmed");
  // Wording and endpoint copied from the real client. It matters which one:
  // Microsoft runs separate device endpoints for personal and work accounts,
  // and a code issued for one is rejected by the other as "expired".
  process.stdout.write("Please authorise this application by visiting the following URL:\n");
  process.stdout.write("https://login.microsoft.com/device\n");
  process.stdout.write("Enter the following code when prompted: FAKE-CODE-123\n");
  process.stdout.write("This code expires at: 2026-Aug-26 20:49:38\n");

  if (process.env.FAKE_DEVICE_REFUSED === "1") {
    process.stdout.write("ERROR: this tenant does not allow the device code flow\n");
    process.exit(1);
  }

  for (let waited = 0; waited < 30_000; waited += 100) {
    if (existsSync(confirmFile)) {
      mkdirSync(confDir, { recursive: true });
      writeFileSync(join(confDir, "refresh_token"), "fake-refresh-token\n");
      process.stdout.write("Authorised. Quota: 1024 MB remaining\n");
      process.exit(0);
    }
    await sleep(100);
  }
  process.stdout.write("The device code expired\n");
  process.exit(1);
}

if (has("--logout")) {
  process.stdout.write("Signed out\n");
  process.exit(0);
}

if (has("--display-config")) {
  const file = join(confDir || ".", "config");
  process.stdout.write(existsSync(file) ? readFileSync(file, "utf8") : "no config\n");
  process.stdout.write(`sync_dir = "${syncDir}"\n`);
  process.exit(0);
}

if (has("--display-sync-status")) {
  process.stdout.write("No pending remote changes\n");
  process.exit(0);
}

if (has("--display-quota")) {
  process.stdout.write("Total: 1024 MB\nUsed: 128 MB\nRemaining: 896 MB\n");
  process.exit(0);
}

if (has("--get-sharepoint-drive-id")) {
  const site = valueOf("--get-sharepoint-drive-id");
  process.stdout.write(
    `Library Name = ${site} Documents\ndrive_id = b!FAKEDRIVEID123\n\n` +
      `Library Name = ${site} Archive\ndrive_id = b!FAKEDRIVEID456\n`
  );
  process.exit(0);
}

if (has("--sync") && has("--dry-run")) {
  process.stdout.write("DRY-RUN: would download 3 files\n");
  process.exit(0);
}

// Monitor mode: emit a line now and then until we are asked to stop, so the
// station has something to tail and a process to supervise.
if (has("--monitor")) {
  const exitAfter = Number(process.env.FAKE_MONITOR_EXIT || 0);

  // The real client refuses to run and exits with EXIT_RESYNC_REQUIRED (126)
  // when its configuration changed since the last run, which includes the very
  // first run after a sign-in. A marker file reproduces that: the demand is
  // raised once and satisfied by a start that carries --resync.
  const resyncMarker = join(confDir || ".", ".resync-demanded");
  if (process.env.FAKE_DEMAND_RESYNC === "1" && !has("--resync") && !existsSync(resyncMarker)) {
    writeFileSync(resyncMarker, "demanded\n");
    process.stdout.write("An application configuration change has been detected\n");
    process.exit(126);
  }

  process.stdout.write(`Starting monitor mode for ${syncDir}\n`);
  if (has("--resync")) process.stdout.write("Performing a database resync\n");

  let stopping = false;
  const finish = () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write("Shutting down\n");
    process.exit(0);
  };
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);

  if (exitAfter) {
    setTimeout(() => process.exit(exitAfter), 300);
  }
  setInterval(() => process.stdout.write("Syncing changes\n"), 500);
  // Keep the event loop alive until a signal arrives.
  await new Promise(() => {});
}

process.stdout.write(`unhandled arguments: ${argv.join(" ")}\n`);
process.exit(2);
