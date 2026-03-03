FROM ironcurtain-base:latest

# Install Goose CLI
# The binary is distributed as a single statically-linked Rust executable.
# Downloaded from GitHub releases and placed in /usr/local/bin/.
USER root

ARG GOOSE_VERSION=1.26.1
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) GOOSE_ARCH=x86_64 ;; \
      arm64) GOOSE_ARCH=aarch64 ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/block/goose/releases/download/v${GOOSE_VERSION}/goose-${GOOSE_ARCH}-unknown-linux-gnu.tar.bz2" \
      -o /tmp/goose.tar.bz2 && \
    tar -xjf /tmp/goose.tar.bz2 -C /usr/local/bin/ && \
    chmod +x /usr/local/bin/goose && \
    rm -f /tmp/goose.tar.bz2 && \
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Entrypoint: bridges UDS proxy, writes Goose config, hands off to CMD
COPY entrypoint-goose.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Pre-create Goose config directory
USER codespace
RUN mkdir -p /home/codespace/.config/goose

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
