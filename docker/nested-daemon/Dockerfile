# Reuse the same pinned builder as the fixed relay. The tiny wrapper adds
# runc's --no-new-keyring option for ordinary runs and integrated BuildKit RUN
# without admitting the keyctl syscall to the outer sidecar profile.
FROM golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac AS shim-build
WORKDIR /src
COPY runtime-shim/main.go ./main.go
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/runc ./main.go \
    && install -d -o 1000 -g 1000 -m 0700 /out/api

# The stock rootless image is input bytes only. A scratch final stage clears
# its inherited anonymous VOLUME declarations and exposed TCP ports so every
# writable state root is explicitly named, leased, watched, and deleted by the
# trusted coordinator.
FROM docker@sha256:67c4114553192e9072969fc347426048cfe4192385dc762d8eb449c05e904255 AS stock

FROM scratch
COPY --from=stock / /

# Docker named-volume copy-up preserves this image-owned directory metadata.
# The daemon sidecar therefore receives a private API root already owned by
# the rootless UID without an initializer container or CAP_CHOWN.
COPY --from=shim-build --chown=1000:1000 --chmod=0700 /out/api/ /run/ironcurtain-docker/
COPY --from=shim-build --chown=0:0 --chmod=0555 /out/runc /usr/local/lib/ironcurtain/runc

ARG IRONCURTAIN_BUILD_HASH_SCHEMA=""
ARG IRONCURTAIN_BUILD_HASH=""
ARG IRONCURTAIN_ARCHITECTURE=""
ARG IRONCURTAIN_DOCKER_API_MIN=""
ARG IRONCURTAIN_DOCKER_API_MAX=""
ARG IRONCURTAIN_RUNTIME_TRUST_SCHEMA=""
ARG IRONCURTAIN_TOOLCHAIN_DIGEST=""
ARG IRONCURTAIN_PROVENANCE_DIGEST=""

LABEL ironcurtain.build-hash-schema="${IRONCURTAIN_BUILD_HASH_SCHEMA}" \
      ironcurtain.build-hash="${IRONCURTAIN_BUILD_HASH}" \
      ironcurtain.architecture="${IRONCURTAIN_ARCHITECTURE}" \
      ironcurtain.docker-api-min="${IRONCURTAIN_DOCKER_API_MIN}" \
      ironcurtain.docker-api-max="${IRONCURTAIN_DOCKER_API_MAX}" \
      ironcurtain.runtime-trust-schema="${IRONCURTAIN_RUNTIME_TRUST_SCHEMA}" \
      ironcurtain.toolchain-digest="${IRONCURTAIN_TOOLCHAIN_DIGEST}" \
      ironcurtain.provenance-digest="${IRONCURTAIN_PROVENANCE_DIGEST}" \
      com.ironcurtain.docker-workload.image-role="nested-daemon"

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/home/rootless \
    DOCKER_VERSION=29.2.1 \
    DOCKER_BUILDX_VERSION=0.31.1 \
    DOCKER_COMPOSE_VERSION=5.1.0 \
    DOCKER_TLS_CERTDIR="" \
    DOCKERD_ROOTLESS_ROOTLESSKIT_NET=none \
    XDG_RUNTIME_DIR=/run/ironcurtain-docker

USER rootless
WORKDIR /home/rootless
ENTRYPOINT ["dockerd-entrypoint.sh"]
