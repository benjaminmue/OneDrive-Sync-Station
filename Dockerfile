# OneDrive Sync Station
#
# Stage 1 builds the OneDrive Client for Linux from source at a pinned tag, so
# the exact client version shipped here is reproducible and under our control.
# Stage 2 runs the station on top of Node. Both stages are Debian trixie based:
# the client is linked against that distribution's libphobos, libcurl and
# sqlite, so the runtime has to be the same release for the ABI to match.

ARG ONEDRIVE_VERSION=v2.5.11

FROM debian:trixie AS client-build
ARG ONEDRIVE_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential \
       ca-certificates \
       git \
       ldc \
       libcurl4-openssl-dev \
       libsqlite3-dev \
       pkg-config \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 --branch "${ONEDRIVE_VERSION}" \
      https://github.com/abraunegg/onedrive.git . \
  && ./configure \
  && make clean \
  && make \
  && make install

FROM node:22-trixie-slim
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
       libphobos2-ldc-shared110 \
       libsqlite3-0 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=client-build /usr/local/bin/onedrive /usr/local/bin/onedrive

# Fail the build rather than the first sync if a runtime library is missing.
RUN onedrive --version

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEBUI_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
