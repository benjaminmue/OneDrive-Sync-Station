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
mkdir -p "$STATION_HOME" "$CONFIG_DIR/instances" "$CONFIG_DIR/auth" "$DATA_DIR"

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
    echo '{"level":"info","msg":"applying ownership '"$PUID:$PGID"' to config and data (one-time)"}'
    for dir in "$CONFIG_DIR" "$DATA_DIR"; do
      [ -d "$dir" ] || continue
      chown -R "$PUID:$PGID" "$dir" 2>/dev/null \
        || echo '{"level":"warn","msg":"could not chown '"$dir"', check the host permissions"}'
    done
    # CONFIG_DIR is left at its stricter permissions on purpose: settings.json
    # holds the web UI password hash and the cookie secret, and the instance
    # directories hold the Microsoft refresh tokens.
    find "$DATA_DIR" -perm -g=r -exec chmod g+w {} + 2>/dev/null || true
    if touch "$MARKER" 2>/dev/null; then
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

# Word splitting on $RUNAS is intentional: it is either empty or "gosu uid:gid".
# shellcheck disable=SC2086
exec $RUNAS env HOME="$STATION_HOME" node src/server.js
