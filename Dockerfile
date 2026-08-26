# OneDrive Sync Station
#
# Stage 1 builds the OneDrive Client for Linux from source at a pinned tag, so
# the exact client version shipped here is reproducible and under our control.
# Stage 2 runs the station on top of Node 24, whose built-in node:sqlite is what
# reads the client item cache for the folder listing. Both stages are Debian
# trixie based:
# the client is linked against that distribution's libphobos, libcurl and
# sqlite, so the runtime has to be the same release for the ABI to match.

ARG ONEDRIVE_VERSION=v2.5.11
# The commit the tag pointed at when it was pinned. A git tag can be moved, so
# the tag alone does not make the build reproducible; the checkout is verified
# against this commit and the build fails if upstream ever re-points it.
ARG ONEDRIVE_COMMIT=0b7299adb170d789d27d517963bc65fb04e0bd63

FROM debian:trixie AS client-build
ARG ONEDRIVE_VERSION
ARG ONEDRIVE_COMMIT

# libdbus-1-dev is not optional: the client's configure script enables dbus
# support unconditionally on Linux and fails without it. The container never
# talks to a session bus, but the dependency has to be satisfied to build.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential \
       ca-certificates \
       git \
       ldc \
       libcurl4-openssl-dev \
       libdbus-1-dev \
       libsqlite3-dev \
       pkg-config \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 --branch "${ONEDRIVE_VERSION}" \
      https://github.com/abraunegg/onedrive.git . \
  && actual="$(git rev-parse HEAD)" \
  && if [ "${actual}" != "${ONEDRIVE_COMMIT}" ]; then \
       echo "Tag ${ONEDRIVE_VERSION} points at ${actual}, expected ${ONEDRIVE_COMMIT}." >&2; \
       echo "Upstream moved the tag. Review the change, then update ONEDRIVE_COMMIT." >&2; \
       exit 1; \
     fi \
  && ./configure \
  && make clean \
  && make \
  && make install

FROM node:24-trixie-slim
ARG ONEDRIVE_VERSION
ENV NODE_ENV=production
WORKDIR /app

# Runtime libraries of the client plus gosu, used by the entrypoint to drop from
# root to PUID:PGID once ownership has been fixed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       gosu \
       libcurl4t64 \
       libdbus-1-3 \
       libphobos2-ldc-shared110 \
       libsqlite3-0 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=client-build /usr/local/bin/onedrive /usr/local/bin/onedrive

# Fail the build rather than the first sync if a runtime library is missing.
RUN onedrive --version

# No glob on the lock file, and `npm ci` rather than `npm install`: both would
# otherwise let the image resolve versions that were never committed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

LABEL org.opencontainers.image.title="OneDrive Sync Station" \
      org.opencontainers.image.description="Web UI and Docker container to sync multiple OneDrive Personal, Business and SharePoint accounts." \
      org.opencontainers.image.source="https://github.com/benjaminmue/OneDrive-Sync-Station" \
      org.opencontainers.image.licenses="MIT" \
      com.onedrive-sync-station.client-version="${ONEDRIVE_VERSION}"

ENV CONFIG_DIR=/config \
    DATA_DIR=/data \
    WEBUI_PORT=8080 \
    TZ=Europe/Zurich \
    PUID=99 \
    PGID=100 \
    UMASK=0002 \
    FIX_PERMISSIONS=true

VOLUME ["/config", "/data"]
EXPOSE 8080

# A generous start period on purpose: the first start may have to take ownership
# of an existing data share, and a recursive chown across a large Unraid array
# can take a long while. A short window would mark the container unhealthy mid
# pass, and a restart would begin the same work again from the top.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEBUI_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
