# syntax=docker/dockerfile:1.7
FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY go.mod main.go ./
ARG TARGETOS=linux
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/ironcurtain-fixed-relay ./main.go

FROM scratch
COPY --from=build /out/ironcurtain-fixed-relay /ironcurtain-fixed-relay
LABEL org.opencontainers.image.title="IronCurtain fixed-target relay" \
      org.opencontainers.image.source="https://github.com/provos/ironcurtain" \
      org.opencontainers.image.version="1" \
      com.ironcurtain.docker-workload.component="fixed-relay"
USER 65532:65532
ENTRYPOINT ["/ironcurtain-fixed-relay"]
