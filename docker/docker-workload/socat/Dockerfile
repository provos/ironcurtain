# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# Built entirely from the digest-pinned Go toolchain already used by the other
# workload images, so the forwarder is fully offline-reproducible and needs no
# external base image digest.
FROM golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac AS build
WORKDIR /src
COPY go.mod socat.go ./
ARG TARGETOS=linux
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/ironcurtain-socat ./socat.go

FROM scratch
COPY --from=build /out/ironcurtain-socat /ironcurtain-socat
ARG IRONCURTAIN_BUILD_HASH_SCHEMA=""
ARG IRONCURTAIN_BUILD_HASH=""
ARG IRONCURTAIN_ARCHITECTURE=""
ARG IRONCURTAIN_DOCKER_API_MIN=""
ARG IRONCURTAIN_DOCKER_API_MAX=""
ARG IRONCURTAIN_RUNTIME_TRUST_SCHEMA=""
ARG IRONCURTAIN_TOOLCHAIN_DIGEST=""
ARG IRONCURTAIN_PROVENANCE_DIGEST=""
ARG IRONCURTAIN_CATALOG_GENERATION=""
LABEL org.opencontainers.image.title="IronCurtain bundle socket forwarder" \
      org.opencontainers.image.source="https://github.com/provos/ironcurtain" \
      org.opencontainers.image.version="1" \
      com.ironcurtain.docker-workload.component="socat" \
      ironcurtain.build-hash-schema="${IRONCURTAIN_BUILD_HASH_SCHEMA}" \
      ironcurtain.build-hash="${IRONCURTAIN_BUILD_HASH}" \
      ironcurtain.architecture="${IRONCURTAIN_ARCHITECTURE}" \
      ironcurtain.docker-api-min="${IRONCURTAIN_DOCKER_API_MIN}" \
      ironcurtain.docker-api-max="${IRONCURTAIN_DOCKER_API_MAX}" \
      ironcurtain.runtime-trust-schema="${IRONCURTAIN_RUNTIME_TRUST_SCHEMA}" \
      ironcurtain.toolchain-digest="${IRONCURTAIN_TOOLCHAIN_DIGEST}" \
      ironcurtain.provenance-digest="${IRONCURTAIN_PROVENANCE_DIGEST}" \
      ironcurtain.catalog-generation="${IRONCURTAIN_CATALOG_GENERATION}"
USER 65532:65532
ENTRYPOINT ["/ironcurtain-socat"]
