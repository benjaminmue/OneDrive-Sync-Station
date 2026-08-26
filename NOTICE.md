# Third-party software notice

## OneDrive Client for Linux

This project is a management layer around the
[OneDrive Client for Linux](https://github.com/abraunegg/onedrive) by
[@abraunegg](https://github.com/abraunegg). All syncing is performed by that
client; this project only configures it, supervises its processes and exposes a
web UI.

The client is licensed under the **GNU General Public License v3.0**. The
container image built from this repository **contains a compiled copy of that
client**, built from source at a pinned release tag (see `ONEDRIVE_VERSION` in
the `Dockerfile`). This has consequences worth stating plainly:

- The GPL-3.0 terms apply to the client binary inside the image. Its complete
  source is publicly available at <https://github.com/abraunegg/onedrive>, and
  the image records the exact tag it was built from in the
  `com.onedrive-sync-station.client-version` label.
- The code in this repository is separate work licensed under MIT (see
  `LICENSE`). It communicates with the client only through its documented
  command line interface and its configuration files, which is mere aggregation
  rather than a derived work.
- No modifications are made to the client's source.

If you redistribute the image, you carry the same obligation to make the
client's source available. Pointing at the upstream repository and the pinned
tag satisfies it.

## Relationship to Microsoft

This is an independent, unofficial project. It is not affiliated with, endorsed
by or supported by Microsoft. "OneDrive", "SharePoint" and "Microsoft 365" are
trademarks of Microsoft Corporation and are used here only to describe what the
software connects to.

Authentication uses the upstream client's own public client application
registration and delegated permissions. No client secret is involved, and this
project never sees your Microsoft credentials: you sign in on Microsoft's own
pages, and only the resulting authorisation code passes through the UI.
