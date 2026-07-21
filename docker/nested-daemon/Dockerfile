# The stock rootless image is input bytes only. A scratch final stage clears
# its inherited anonymous VOLUME declarations and exposed TCP ports so every
# writable state root is explicitly named, leased, watched, and deleted by the
# trusted coordinator.
FROM docker@sha256:67c4114553192e9072969fc347426048cfe4192385dc762d8eb449c05e904255 AS stock

FROM scratch
COPY --from=stock / /

ARG IRONCURTAIN_BUILD_HASH_SCHEMA=""
ARG IRONCURTAIN_BUILD_HASH=""
ARG IRONCURTAIN_ARCHITECTURE=""
ARG IRONCURTAIN_DOCKER_API_MIN=""
ARG IRONCURTAIN_DOCKER_API_MAX=""
ARG IRONCURTAIN_RUNTIME_TRUST_SCHEMA=""
ARG IRONCURTAIN_TOOLCHAIN_DIGEST=""
ARG IRONCURTAIN_PROVENANCE_DIGEST=""
ARG IRONCURTAIN_CATALOG_GENERATION=""

LABEL ironcurtain.build-hash-schema="${IRONCURTAIN_BUILD_HASH_SCHEMA}" \
      ironcurtain.build-hash="${IRONCURTAIN_BUILD_HASH}" \
      ironcurtain.architecture="${IRONCURTAIN_ARCHITECTURE}" \
      ironcurtain.docker-api-min="${IRONCURTAIN_DOCKER_API_MIN}" \
      ironcurtain.docker-api-max="${IRONCURTAIN_DOCKER_API_MAX}" \
      ironcurtain.runtime-trust-schema="${IRONCURTAIN_RUNTIME_TRUST_SCHEMA}" \
      ironcurtain.toolchain-digest="${IRONCURTAIN_TOOLCHAIN_DIGEST}" \
      ironcurtain.provenance-digest="${IRONCURTAIN_PROVENANCE_DIGEST}" \
      ironcurtain.catalog-generation="${IRONCURTAIN_CATALOG_GENERATION}" \
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
