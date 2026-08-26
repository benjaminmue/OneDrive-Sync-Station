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

> **Status: proof of concept.** The flow works end to end against a stubbed
> client and the full test suite passes, but the image has not yet been
> exercised against real Microsoft accounts. Do not point it at data you cannot
> lose yet.

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
- **Selective sync.** Per account, an editor for the client's `sync_list` rules
  with a dry-run preview. Saving triggers the resync the client requires after
  every change.
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
  ghcr.io/benjaminmue/onedrive-sync-station:latest
```

Then open `http://<host>:8080`, set a password, and add your first account.

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
4. Syncing starts on its own.

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

Sign in with a business account first, then use **SharePoint lookup** with the
site name or URL. It returns the drive IDs of that site's document libraries.
Create an account of type *SharePoint library* with the ID you want.

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

Saving restarts the account with `--resync`, which the client requires after
every change to the selection. That re-reads the account state from Microsoft;
it does not delete local data.

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
| `src/validate.js` | All input validation |

## Credits

All syncing is done by the [OneDrive Client for Linux](https://github.com/abraunegg/onedrive)
by [@abraunegg](https://github.com/abraunegg), licensed GPL-3.0 and built into
the image from source at a pinned tag. See [NOTICE.md](NOTICE.md).

This project's own code is MIT licensed. It is not affiliated with Microsoft.
