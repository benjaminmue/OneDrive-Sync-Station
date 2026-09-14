# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every published image carries a version. The header of the web UI shows it
together with the commit the image was built from, so it is always possible to
tell which build is running.

## [0.7.0] - unreleased

### Changed

- The folder list is read from Microsoft Graph. It used to come from a dry run
  of the sync client, which fetches the account's changes and then walks every
  single file as if it were downloading it; on a personal account with a few
  thousand files the list took more than a quarter of an hour (#3). Graph
  delivers the folders in a few requests, including the ones already synced,
  which the dry run left out. Folders inside a folder shared into the account
  are not listed; the shared folder itself is. The station redeems the client's
  refresh token for an access token held in memory only; the token file is never
  written, which is safe because Microsoft does not revoke a refresh token when
  it is redeemed. The dry run remains as the fallback when Graph fails.
- Reloading the folder list no longer pauses a running account. Only the
  dry-run fallback still needs the client stopped.

### Fixed

- A synced folder could be marked "only here" although it exists in OneDrive
  (#4). A dry run names only the folders missing locally, and reloading the list
  replaced the stored one, so a folder dropped out of it once it was downloaded;
  right after a resync the client's cache was empty as well. The marker is now
  shown only against a list read from Graph, which names every folder, and
  never inside a shared folder.
- A client waiting out its restart backoff was not stopped before a dry run of
  the folder list, so its timer could start it in the middle of the run, on the
  same config directory and without a selection, which means the whole account.
  Start and restart are also refused while such a run holds the account.
- A selection moved aside by a dry run that was interrupted, for example by a
  container stop, is put back when the station starts. Shutting down now waits
  for a running dry run to put the selection back itself.

## [0.6.1] - 2026-09-14

### Security

- The API could be used without signing in. The session check compared the
  raw request URL with `/api/`, while the router matches the decoded path, so
  `/%61pi/instances` reached `/api/instances` with no session: account list,
  client config, start, stop and every other API route. The check now uses the
  route the router matched. Anyone who ran an earlier version where untrusted
  devices can reach the web UI should treat the accounts as exposed and sign
  them out and in again.
- Requests that change something are refused when the browser reports another
  origin. The session cookie is `SameSite=Lax`, which does not stop another web
  service on the same host from sending it along with a plain form-like POST.
- `@fastify/static` updated from 8.3.0 to 10.1.3 for four high-severity
  advisories (path traversal and route guard bypass in the static file
  handler).

### Fixed

- Synced files could not be opened over an SMB share. The sync client sets
  every download to 0600 and every folder to 0700 on its own, overriding the
  container's `UMASK`, so the Unraid defaults `PUID=99`, `PGID=100` and
  `UMASK=0002` promised 0664/0775 and delivered files only their owner could
  read. The generated client config now sets `disable_permission_set`, and
  `UMASK` alone decides the modes of new files. Changing this key does not make
  the client demand a resync. Reported in #1.
- A setting added to the generated client config never reached an existing
  account, because the file was only written when an account was created or
  edited. Every client config is now rendered again when the station starts.
  An account whose config cannot be written is logged and not started, instead
  of keeping the whole station down.

### Added

- **Repair file permissions** in an account's Tools tab. It changes files at
  exactly 0600 and folders at exactly 0700 in that account's folder to the
  modes `UMASK` gives, for everything downloaded before this version. It is a
  button and not an automatic step on update, because those modes can also have
  been chosen on purpose. It asks before it changes anything, never follows a
  symbolic link and leaves files with several hard links alone.

## [0.6.0] - 2026-08-27

### Fixed

- Starting an account with nothing selected downloaded the entire account. An
  empty selection means "everything" to the sync client, and pressing Start
  offered no hint of that, so a SharePoint library began pulling its whole
  archive with every checkbox unticked. Starting without a selection is now
  refused until the full download is accepted explicitly; the two "sync
  everything" buttons carry that acceptance, because choosing them is the
  acceptance.
- The folder list could not read the client's database while an account was
  running. The client holds a lock, and opening read-only is not enough against
  it, so the list quietly fell back to weaker sources and showed fewer folders
  than exist. It reads from a copy now and no longer contends for the lock.
- Folders that had just been downloaded were marked as existing only on this
  server. With the database unreadable, no online source had anything to say,
  and everything on disk looked local-only. Nothing is claimed unless an online
  source actually answered.

## [0.5.0] - 2026-08-27

Findings from an independent review by a second model (OpenAI Codex), which had
not seen the code being written. Nine held up, one did not.

### Security

- A percent-encoded option marker could reach the sync client's argument list.
  `.../sites/%2Dresync` passed the check for a leading dash, because the check
  ran on the raw value and the decoding happened afterwards. The reduction of a
  pasted library URL to a site name now lives in the validation module and
  validates the decoded result, which is what the argument list actually
  receives.
- The login throttle keyed on `request.ip` while the server trusted every proxy
  header, so a different `X-Forwarded-For` on each attempt bought a fresh bucket
  and the throttle did nothing. Proxy headers are now trusted only for the
  addresses named in `TRUSTED_PROXIES`, and not at all by default.
- Concurrent unauthenticated requests each spawned their own client process to
  read the version, because the cache only filled after the first call returned.
  A burst could exhaust the container's process limit without a session.

### Fixed

- A folder selection saved during a discovery run was silently discarded. The
  run parks the existing selection and puts it back when it ends, deleting
  whatever arrived in the meantime. Saves now go to the parked copy while a run
  holds it, and take effect when the run finishes.
- A client that demanded a resync twice in a row wedged its account. The station
  granted the demand once and then restarted without `--resync` forever, which
  could only produce the same refusal. Repeated demands now back off, but keep
  carrying the flag the client is asking for.
- The drive id lookup could hand an account a spent refresh token: if the
  account's own client rotated its token during the lookup, the older copy was
  written over the newer one. The write happens only if the source is unchanged,
  and it is atomic.
- Two lookups for one account shared a fixed scratch directory and could delete
  each other's, mid-run. Each run gets its own directory and a second lookup for
  the same account is refused instead.
- A failure while creating the scratch directory left it behind, refresh token
  included. Cleanup now covers setup failures and never masks the result.

### Not changed

- The review also reported a race between two first-time password setups. There
  is none: the hashing is synchronous and the handler cannot be interleaved. A
  second check was added anyway, because it costs nothing and keeps that true if
  the hashing ever becomes asynchronous.

## [0.4.2] - 2026-08-27

### Fixed

- The quick start pulled `:latest`, a tag that does not exist and will not until
  the first version tag, so copying the command failed. It pulls `:beta`, and
  says why.

### Changed

- The container is in Community Applications now, published from the beta
  channel. README says so, with the template URL for adding it without CA.

## [0.4.1] - 2026-08-27

### Changed

- README brought in line with what the project actually does: all three account
  types are now verified against real accounts, the AI assistance behind the
  code is disclosed up front, and a `Known gaps` section names what is missing
  rather than leaving it to be discovered.

## [0.4.0] - 2026-08-27

### Added

- Accounts show a pulsing "in progress" state while a discovery run or a sign-in
  is under way. Both stop the client process, so the card used to read "Stopped"
  directly above a line saying the folder list was being fetched. The animation
  is dropped for readers who ask for reduced motion, where the state is marked
  by a steady ring instead.

## [0.3.0] - 2026-08-27

### Fixed

- Every container start forced a full resync on every account, and the drive id
  lookup could not run at all. Both had the same cause: the client treats a
  `--syncdir` that differs from its config file as a configuration change and
  demands a resync for it, unless it believes it is running in a container. It
  decides that solely by whether `/entrypoint.sh` exists. This image installed
  its entrypoint under a different name, so the client never recognised the
  container and re-read every account from scratch on each start, with nothing
  in the logs pointing at the reason. The entrypoint now sits where the client
  looks, and a test guards the path.

## [0.2.6] - 2026-08-27

### Fixed

- The directory listing added in 0.2.5 assigned to a constant and turned every
  refused lookup into an internal error. The path had no test, which is why it
  shipped; it has one now.

## [0.2.5] - 2026-08-27

### Added

- A drive id lookup that is refused in its own directory lists what that
  directory actually held. The directory is created empty and receives one file,
  so a refusal blaming a changed configuration is about something the client
  brought along itself, and nothing else can tell us what.

## [0.2.4] - 2026-08-27

### Added

- A failed drive id lookup says which of its two runs failed and what to do
  about it, instead of leaving the client's raw output to be interpreted. The
  lookup runs directly first and repeats itself in a separate directory when the
  account owes a resync, and those two failures need different answers.

## [0.2.3] - 2026-08-27

### Added

- The site field takes a pasted library address as well as a site name. The
  client searches by name and finds nothing when handed a full address, which is
  the obvious thing to paste, since the browser is open on the library anyway.
  The name that was searched for is reported back.
- Folders that exist only on this server are covered by tests, so the marking
  cannot silently invert and label everything.

### Fixed

- The drive id lookup no longer passes `--resync`, which the client rejects in
  combination with it. It is not needed: the throwaway directory holds no config
  file, so the client computes no config hash, has nothing to compare, and asks
  for no resync at all.

## [0.2.2] - 2026-08-27

### Fixed

- The SharePoint drive id lookup no longer fails on an account that owes a
  resync, which is every account that has just been signed in or reconfigured.
  The client refuses to run anything at all in that state, a read-only lookup
  included. Granting the resync where the account lives would delete its item
  database and cost it a full reconciliation, so the lookup is repeated in a
  throwaway directory that holds nothing but a copy of the token. The token
  Microsoft rotates in the process is written back, and a running client is
  restarted so it does not keep using the spent one.

## [0.2.1] - 2026-08-26

### Added

- Folders that exist on this server but not in OneDrive are marked as such in
  the folder list, and a note above the list counts the ones the selection does
  not cover. A folder created here stays here until it is selected, and until
  now nothing said so: the existing report only sees files, so an empty new
  folder was silently left without a copy anywhere.

## [0.2.0] - 2026-08-26

First version exercised against real Microsoft accounts. A personal account and
a business account were synced end to end on Unraid: sign-in, folder selection,
download, upload and deletion in both directions.

### Added

- Folder list to tick, instead of typing `sync_list` rules by hand. It is read
  from what the client already knows, from what a discovery run reported, and
  from what is on disk, because none of those sources sees the whole account by
  itself.
- Discovery run: looks at an account and downloads nothing. Started
  automatically after a sign-in, so the folder choice arrives with the list
  already in hand.
- Sign-in with a device code for business and SharePoint accounts.
- Sync interval configurable per account.
- Report of local files the folder selection leaves unprotected. They are never
  uploaded, and nothing else in the interface would say so.
- Build stamp in the header, next to the version.

### Changed

- Syncing no longer starts by itself after a sign-in. The account waits for an
  explicit Start, so a large account cannot pull gigabytes before the folder
  selection is even on screen.
- The sign-in panel quotes Microsoft's phishing warning and explains it, since
  the warning is alarming, the page redirects itself within seconds, and the
  address is only recoverable from the browser history afterwards.
- The log view hides the "skipped path" lines a selection produces on every run
  and holds far more lines, so a resync no longer buries everything readable.

### Fixed

- The client's resync demand (exit 126) is granted automatically instead of
  being treated as a crash. It occurs after every configuration change and after
  the first sign-in, and it put healthy accounts into a growing backoff.
- The device code pointed at the wrong Microsoft endpoint, which rejected
  perfectly fresh codes as expired.
- Device sign-in is no longer offered to personal accounts: Microsoft blocks
  that flow for them, and reports the refusal as an expired code.
- A sign-in in progress survives the panel closing; reopening shows the same
  code instead of silently requesting a new one and invalidating it.
- Copy buttons work over plain http, where the clipboard API does not exist.
- Folder selection ticks match the rules in the editor.
- Numerous lifecycle defects found in review: a failed spawn wedging an account
  permanently, a cancelled sign-in leaving a client running, two clients able to
  share one config directory, and a corrupt settings file opening the station to
  anyone on the network.

## [0.1.0] - 2026-08-26

Proof of concept: multiple OneDrive Personal, Business and SharePoint accounts
in one container, with a password protected web UI, verified against a stubbed
client.
