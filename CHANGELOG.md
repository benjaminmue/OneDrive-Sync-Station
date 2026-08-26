# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every published image carries a version. The header of the web UI shows it
together with the commit the image was built from, so it is always possible to
tell which build is running.

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
