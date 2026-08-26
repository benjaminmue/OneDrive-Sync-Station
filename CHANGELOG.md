# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Proof of concept: multiple OneDrive Personal, Business and SharePoint accounts
  in one container, each with its own client process, config directory and data
  folder.
- Browser driven Microsoft sign-in through the client's `--auth-files`
  handshake. No client secret and, for most tenants, no app registration of your
  own.
- Per-account folder selection through the client's `sync_list`, with a dry-run
  preview and the resync the client requires after a change.
- SharePoint drive ID lookup using the credentials of an account that is already
  signed in.
- Live client logs over server-sent events.
- Password protected web UI with an `ADMIN_PASSWORD` recovery path.
- Container image with the OneDrive Client for Linux built from source at a
  pinned release tag.

### Known limitations

- Not yet exercised against real Microsoft accounts; the test suite drives a
  stub client.
- The folder selection is a rule editor. A browsable folder tree via Microsoft
  Graph is planned, pending a check on how a second consumer of the refresh
  token affects the running client.
- `linux/amd64` only. Building the D client for arm64 under emulation is not
  practical, and the target platform is Unraid.
