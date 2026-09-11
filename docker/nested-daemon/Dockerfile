ARG IRONCURTAIN_DOCKER_SOURCE=docker:29.2.1-dind-rootless

# Reuse the same builder as the fixed relay. The tiny wrapper adds
# runc's --no-new-keyring option for ordinary runs and integrated BuildKit RUN
# without admitting the keyctl syscall to the outer sidecar profile.
FROM golang:1.26.1 AS shim-build
WORKDIR /src
COPY runtime-shim/main.go ./main.go
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/runc ./main.go \
    && install -d -o 0 -g 0 -m 0755 /out/api \
    && install -d -o 0 -g 0 -m 0755 /out/build-trust /out/docker-toolchain

# The stock rootless image is input bytes only. A scratch final stage clears
# its inherited anonymous VOLUME declarations and exposed TCP ports so every
# writable state root is explicitly named, leased, watched, and deleted by the
# trusted coordinator.
FROM ${IRONCURTAIN_DOCKER_SOURCE} AS stock

FROM scratch
COPY --from=stock / /

# Docker named-volume copy-up preserves this image-owned directory metadata.
# The entrypoint creates a private child as the configured rootless UID using
# only SETUID/SETGID. The parent remains root-owned; no CAP_CHOWN is required.
COPY --from=shim-build --chown=0:0 --chmod=0755 /out/api/ /run/ironcurtain-docker/
COPY --chown=0:0 --chmod=0555 entrypoint.sh /usr/local/lib/ironcurtain/daemon-entrypoint.sh
COPY --from=shim-build --chown=0:0 --chmod=0555 /out/runc /usr/local/lib/ironcurtain/runc
# The package-build profile reuses the same build-trust runtime as Apple.
# Keep stock real runc at the common path expected by that
# wrapper; the wrapper and per-session public trust files are mounted only in
# package mode.
COPY --from=shim-build /out/build-trust/ /ironcurtain-build-trust/
COPY --from=shim-build /out/docker-toolchain/ /usr/local/lib/ironcurtain-docker/bin/
COPY --from=stock --chown=0:0 --chmod=0755 /usr/local/bin/runc /ironcurtain-real-runc

LABEL com.ironcurtain.docker-workload.image-role="nested-daemon"

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/home/rootless \
    DOCKER_VERSION=29.2.1 \
    DOCKER_BUILDX_VERSION=0.31.1 \
    DOCKER_COMPOSE_VERSION=5.1.0 \
    DOCKER_TLS_CERTDIR="" \
    DOCKERD_ROOTLESS_ROOTLESSKIT_NET=none \
    XDG_RUNTIME_DIR=/run/ironcurtain-docker/docker

USER 0:0
WORKDIR /home/rootless
ENTRYPOINT ["/usr/local/lib/ironcurtain/daemon-entrypoint.sh"]
