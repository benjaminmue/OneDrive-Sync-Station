<p align="center">
  <img src="public/logo.svg" width="88" alt="OneDrive Sync Station">
</p>

<h1 align="center">OneDrive Sync Station</h1>

<p align="center">
  Sync several OneDrive Personal, OneDrive Business and SharePoint accounts from
  one container, managed through a web UI. Built on the
  <a href="https://github.com/abraunegg/onedrive">OneDrive Client for Linux</a>. Made for Unraid.
</p>

---

> 🤖 **Built with AI, disclosed openly.** This project is developed with heavy
> assistance from AI (Anthropic's Claude, via Claude Code): code, tests, and
> documentation. This is stated up front, not hidden. It's used for a personal
> homelab; review the code yourself before trusting it with your data, and treat
> it accordingly. Issues and PRs are welcome.

> **Status: early.** All three account types have been synced end to end on real
> hardware: a personal account, a business account and a SharePoint document
> library, each through sign-in, folder selection, download, upload and deletion
> in both directions. It is still young software with one pair of eyes on it. Do
> not point it at data you have no other copy of.

## What it does

- **Several accounts, one container.** Each account runs its own sync client
  with its own configuration and its own folder. No Docker socket, no container
  per account.
- **Personal, Business and SharePoint.** All three sign in the same way. A
  SharePoint document library is added as an account of its own; the UI can look
  up the drive ID of a site with the credentials of a business account that is
  already signed in.
- **Sign-in from the browser.** No terminal, no `docker exec`. The UI shows the
  Microsoft sign-in link and takes the redirect URL back.
- **Selective sync.** Per account, a folder list to tick, backed by an editor
  for the client's `sync_list` rules and a dry-run preview. Saving triggers the
  resync the client requires after every change.
- **Nothing downloads behind your back.** A new account does not start syncing
  on its own. It reads its folder list first, in a run that downloads nothing,
  so the choice comes before the traffic. Folders that exist only on this server
  are marked as such, because those are the ones with no copy anywhere else.
- **Config and data kept apart.** `/config` holds settings and sign-ins,
  `/data` holds nothing but synced files, one subfolder per account.
- **Password protected.** The UI is gated behind a password of its own,
  recoverable through an environment variable.

## Quick start

```bash
docker run -d \
  --name onedrive-sync-station \
  -p 8080:8080 \
  -v /mnt/user/appdata/onedrive-sync-station:/config \
  -v /mnt/user/OneDrive:/data \
  -e PUID=99 -e PGID=100 -e TZ=Europe/Zurich \
  ghcr.io/benjaminmue/onedrive-sync-station:beta
```

Then open `http://<host>:8080`, set a password, and add your first account.

The tag is `:beta` on purpose. `:latest` does not exist until the first version
tag, and pulling it fails.

## Install on Unraid

The container is in **Community Applications**, published from the beta channel,
so it carries a BETA banner. Search for *OneDrive Sync Station* under Apps.

The CA template is maintained in the repository
[`benjaminmue/unraid`](https://github.com/benjaminmue/unraid/blob/main/templates/onedrive-sync-station.xml).
To add the container without CA, use the Docker tab, **Add Container**, and paste
that template URL:

```
https://raw.githubusercontent.com/benjaminmue/unraid/main/templates/onedrive-sync-station.xml
```

Or with compose:

```bash
git clone https://github.com/benjaminmue/OneDrive-Sync-Station.git
cd OneDrive-Sync-Station
docker compose up -d --build
```

## Adding an account

1. **Add account**, give it a name and pick the type.
2. **Sign in.** The UI shows a Microsoft link. Open it, sign in, and you land on
   a blank page.
3. Copy the **full URL of that blank page** from the address bar and paste it
   back into the UI. That URL carries the authorisation code.
4. Decide what to sync. Syncing does **not** start by itself: the account offers
   to look at its folders first (a dry run that downloads nothing), to go
   straight to the selection, or to take everything. Pressing Start begins the
   sync.

Microsoft shows a warning on that blank page, claiming the URL contains your
password and should not be shared. It carries a one-time code, not a password,
and pasting it into the station is its intended use. Copy the address quickly:
the page redirects itself after a few seconds, and the code is then only
recoverable from the browser history.

### Which sign-in method

**Business and SharePoint** can use the device code: the UI shows a short code,
you enter it on one Microsoft page, and the client signs itself in. Nothing is
copied back.

**Personal accounts cannot.** Microsoft blocks the device code grant for
personal accounts (outlook.com, hotmail.com, and the like) unless it has
explicitly approved the application, and refuses the code as expired even
seconds after issuing it. That is
[documented upstream](https://github.com/abraunegg/onedrive/blob/master/docs/usage.md).
Personal accounts therefore use the copy-and-paste method above, and the UI
offers only that.

Nothing else is needed for Personal, Business or SharePoint. In particular:

- **No client secret**, and normally **no app registration of your own**. The
  client is registered with Microsoft as a public client application using
  delegated permissions (`Files.ReadWrite`, `Files.ReadWrite.All`,
  `Sites.ReadWrite.All`, `offline_access`).
- If your tenant requires an administrator to approve the application first, the
  account's **admin consent URL** button produces the link for them.
- If your tenant insists on its own app registration, set the application ID
  (and optionally the tenant ID) in the account's options. That registration must
  be a **public client** with **both** of these redirect URIs, or sign-in fails
  with `AADSTS50011`:
  - `http://127.0.0.1:53100/`
  - `https://login.microsoftonline.com/common/oauth2/nativeclient`

### SharePoint libraries

Sign in with a business account first, then use **SharePoint lookup**. It takes
a site name or the address of the library as it appears in the browser, and
returns the drive IDs of that site's document libraries. Create an account of
type *SharePoint library* with the ID you want.

### Selecting folders

**Folders** opens the `sync_list` editor of an account:

```
# exclusions first, they win over inclusions
!/Documents/temp*
!node_modules/*

# then what should be synced
/Documents/
/Pictures/Camera Roll/*
```

An empty list syncs everything. Rules without a leading slash match anywhere in
the tree and are the expensive kind, because the client has to walk every folder
online and locally to find them.

Above the editor is a list of the account's folders to tick, so the paths do not
have to be typed by hand. It is merged from every source that knows anything:
the client's own cache, the last discovery run, and what is on disk. None of
them sees the whole account by itself, which is why **Reload list** can surface
folders that were not there a minute ago.

Saving restarts the account with `--resync`, which the client requires after
every change to the selection. Note what that means for folders you remove:
their local copies under the data path are deleted on the next run. They remain
in OneDrive. Use **Dry run** first to see what would happen.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WEBUI_PORT` | `8080` | Port of the web UI inside the container |
| `CONFIG_DIR` | `/config` | Settings, per-account client config, refresh tokens |
| `DATA_DIR` | `/data` | Synced files, one subfolder per account |
| `PUID` / `PGID` | `99` / `100` | Ownership of everything the container writes |
| `UMASK` | `0002` | Keeps synced files group-writable, matching Unraid shares |
| `TZ` | `Europe/Zurich` | Timezone for the timestamps in the UI |
| `ADMIN_PASSWORD` | unset | Overwrites the web UI password on start, see below |
| `FIX_PERMISSIONS` | `true` | Repair ownership drift on start |

### Lost the web UI password

Set `ADMIN_PASSWORD` in the container template, restart, sign in, then remove
the variable again. The old password is replaced and all sessions are dropped.

### Volume layout

```
/config
  settings.json              web UI password hash, cookie secret
  instances.json             the account registry
  instances/<account>/       client config, sync_list, refresh token, item database
  auth/                      scratch files for a sign-in in progress
/data
  <account>/                 synced files, nothing else
```

## Security

- The UI can sign in to Microsoft accounts and reads every synced file. It is
  meant for a LAN. Put a reverse proxy with its own authentication in front of
  it before exposing it to the internet.
- Sync clients are started with an argument array, never through a shell.
  Every value that reaches a process argument, a directory name or the client
  config file is validated in one place (`src/validate.js`), which also rejects
  the quotes and newlines that would let a value inject extra client settings.
- Refresh tokens live in `/config` at `0600` and never leave the container.
- The station never sees your Microsoft password: you sign in on Microsoft's
  pages and only the resulting authorisation code passes through the UI.

## Releasing

Every published image gets a version. The header of the web UI shows it next to
the commit the image was built from, which is the only reliable way to tell
whether an update has taken effect.

```bash
npm run release:patch   # fixes
npm run release:minor   # new capabilities
```

Then commit, merge into `beta` to publish `:beta`, or tag `vX.Y.Z` to publish
`:latest`. The publish workflow runs the tests first and refuses to build if
they fail.

## Development

```bash
npm install
npm test                       # unit and API tests, no container needed
ONEDRIVE_BIN=./test/fixtures/fake-onedrive.mjs \
CONFIG_DIR=./tmp/config DATA_DIR=./tmp/data npm start
```

The tests drive the real HTTP API against a stub client
(`test/fixtures/fake-onedrive.mjs`) that implements the file based sign-in
handshake and monitor mode, so the whole flow can be exercised without a
Microsoft account or a container.

| Module | Responsibility |
|---|---|
| `src/app.js` | HTTP routes |
| `src/server.js` | Process entry: startup, shutdown, password recovery |
| `src/instances.js` | Account registry, directory layout, client config rendering |
| `src/supervisor.js` | Child process lifecycle, restart backoff, log buffers |
| `src/authflow.js` | File based Microsoft sign-in handshake |
| `src/onedrive.js` | Client command wrapper and output parsing |
| `src/synclist.js` | Folder selection file |
| `src/discovery.js` | Dry runs that list an account's folders without downloading |
| `src/foldertree.js` | Folder list, merged from every source that knows one |
| `src/validate.js` | All input validation |

## Known gaps

Honest list of what is missing or rough, rather than finding out the hard way:

- **The folder list can be incomplete while an account is running.** The client
  holds a lock on its database, so the list falls back to weaker sources and may
  show fewer folders than exist. Stopping the account and reloading the list
  gives the full picture.
- **No log rotation.** The client's output is held in memory per account and
  capped by line count, but nothing is written to disk in a rotated form yet.
- **Published from the beta channel.** The Community Applications entry points
  at `:beta` and is flagged as beta there. `:latest` does not exist until the
  first version tag, so pulling it fails.
- **One pair of eyes.** No independent review has happened yet.

## Credits

All syncing is done by the [OneDrive Client for Linux](https://github.com/abraunegg/onedrive)
by [@abraunegg](https://github.com/abraunegg), licensed GPL-3.0 and built into
the image from source at a pinned tag. See [NOTICE.md](NOTICE.md).

This project's own code is MIT licensed. It is not affiliated with Microsoft.
