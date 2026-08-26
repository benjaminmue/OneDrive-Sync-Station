#!/bin/sh
set -e

CONFIG_DIR="${CONFIG_DIR:-/config}"
DATA_DIR="${DATA_DIR:-/data}"

# Run the station and every sync client as an unprivileged user, so synced files
# stay usable by other containers. Defaults are Unraid's nobody:users, and
# UMASK 0002 keeps files group-writable (0664/0775) to match Unraid's share
# convention. Set PUID=0 PGID=0 to keep everything running as root.
PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-0002}"

umask "$UMASK"

# Started with `--user`? Then the identity is already fixed and gosu is neither
# possible nor needed.
if [ "$(id -u)" != "0" ]; then
  PUID="$(id -u)"
  PGID="$(id -g)"
  RUNAS=""
else
  RUNAS="gosu $PUID:$PGID"
fi

# The client writes caches into HOME. Point it at the config volume so nothing
# lands in a root-owned /root, and re-apply it after the privilege drop: gosu
# resets HOME from /etc/passwd, where PUID usually has no entry.
STATION_HOME="$CONFIG_DIR/home"
export HOME="$STATION_HOME"

# Failing here is almost always a host permission problem, and under `set -e` it
# would abort with nothing but a bare mkdir error. Name the likely cause instead:
# with `--user`, the mapped host paths have to be writable by that user, because
# the container cannot change its own identity to fix them.
if ! mkdir -p "$STATION_HOME" "$CONFIG_DIR/instances" "$CONFIG_DIR/auth" "$DATA_DIR"; then
  echo '{"level":"error","msg":"cannot create directories under '"$CONFIG_DIR"' and '"$DATA_DIR"'. Check that the mapped host paths exist and are writable by the user this container runs as."}'
  exit 1
fi

# The per-instance directories hold the Microsoft refresh tokens and the client
# item databases, which list every file in the account. They must not inherit
# the group-writable umask that the data share deliberately uses.
chmod 0700 "$CONFIG_DIR/instances" 2>/dev/null || true

# The client aborts a sync run on a single permission error, and files written by
# another user (a root-era container, a host-side copy, a neighbouring container)
# stay unwritable forever. The first start therefore takes ownership of both
# volumes and records a marker; later starts only probe for drift, which costs
# one find that stops at the first stray entry. Set FIX_PERMISSIONS=false to
# skip both and manage ownership by hand.
MARKER="$CONFIG_DIR/.permissions-$PUID-$PGID"

# Print the first entry not owned by PUID, then stop walking. Our own marker is
# skipped so it never names itself as the problem.
find_drift() {
  for dir in "$@"; do
    [ -d "$dir" ] || continue
    if [ "$dir" = "$CONFIG_DIR" ]; then
      first="$(find "$dir" ! -user "$PUID" ! -path "$CONFIG_DIR/.permissions-*" -print -quit 2>/dev/null)"
    else
      first="$(find "$dir" ! -user "$PUID" -print -quit 2>/dev/null)"
    fi
    if [ -n "$first" ]; then
      echo "$first"
      return 0
    fi
  done
  return 1
}

if [ "$(id -u)" = "0" ] && [ "$PUID:$PGID" != "0:0" ] \
   && [ "${FIX_PERMISSIONS:-true}" = "true" ]; then
  if [ ! -f "$MARKER" ]; then
    echo '{"level":"info","msg":"applying ownership '"$PUID:$PGID"' to config and data (one-time, may take a while on a large share)"}'
    chown_ok=1
    for dir in "$CONFIG_DIR" "$DATA_DIR"; do
      [ -d "$dir" ] || continue
      chown -R "$PUID:$PGID" "$dir" 2>/dev/null || {
        chown_ok=0
        echo '{"level":"warn","msg":"could not chown '"$dir"', check the host permissions"}'
      }
    done
    # Group-write is applied to the data volume only, and only to entries that
    # are already group-readable, so a deliberately private subtree stays
    # private. CONFIG_DIR is never widened: it holds the password hash, the
    # cookie secret and the Microsoft refresh tokens.
    find "$DATA_DIR" -perm -g=r -exec chmod g+w {} + 2>/dev/null || true
    # Only claim the work is done when it actually succeeded. A marker written
    # after a failed chown would skip the repair on every later start, leaving
    # files the sync clients cannot write.
    if [ "$chown_ok" = "1" ] && touch "$MARKER" 2>/dev/null; then
      chown "$PUID:$PGID" "$MARKER" 2>/dev/null \
        || echo '{"level":"warn","msg":"could not chown the permissions marker, it stays root-owned"}'
    fi
  elif stray="$(find_drift "$CONFIG_DIR" "$DATA_DIR")"; then
    # Repair only the stray entries: a full pass would be slow on a large share
    # and would re-widen permissions an operator has tightened since.
    echo '{"level":"warn","msg":"found entries not owned by '"$PUID:$PGID"' (first: '"$stray"'), repairing ownership"}'
    for dir in "$CONFIG_DIR" "$DATA_DIR"; do
      [ -d "$dir" ] || continue
      if [ "$dir" != "$CONFIG_DIR" ]; then
        find "$dir" ! -user "$PUID" -perm -g=r -exec chmod g+w {} + 2>/dev/null || true
      fi
      find "$dir" ! -user "$PUID" -exec chown "$PUID:$PGID" {} + 2>/dev/null \
        || echo '{"level":"warn","msg":"could not chown '"$dir"', check the host permissions"}'
    done
  fi
fi

# Run whatever was asked for, which is the image's CMD (the station) unless the
# caller passed something else. That is the conventional entrypoint contract,
# and it is what makes one-off diagnostics possible without bypassing the
# permission setup above, for example:
#
#   docker run --rm onedrive-sync-station onedrive --version
#   docker exec onedrive-sync-station onedrive --confdir /config/instances/x --display-config
#
# Word splitting on $RUNAS is intentional: it is either empty or "gosu uid:gid".
# shellcheck disable=SC2086
exec $RUNAS env HOME="$STATION_HOME" "$@"
