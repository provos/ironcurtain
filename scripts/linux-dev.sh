#!/usr/bin/env bash
#
# Launch a Linux development container for testing IronCurtain.
#
# Uses Docker-in-Docker (DinD) so that IronCurtain's Linux code path
# (UDS bind mounts, --network=none) works correctly. The outer macOS
# Docker socket is NOT forwarded — the container runs its own dockerd.
#
# Expects a separate Linux-dedicated clone of the repo to avoid native
# module conflicts between macOS and Linux:
#
#   git clone git@github.com:provos/ironcurtain ~/src/ironcurtain-linux
#
# Usage:
#   ./scripts/linux-dev.sh              # interactive shell
#   ./scripts/linux-dev.sh --rebuild    # rebuild the image, then shell
#   ./scripts/linux-dev.sh npm test     # run a command and exit
#
# Override the clone location:
#   LINUX_PROJECT_DIR=~/src/ic-linux ./scripts/linux-dev.sh
#

set -euo pipefail

IMAGE_NAME="ironcurtain-linux-dev"
CONTAINER_NAME="ironcurtain-dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LINUX_PROJECT_DIR="${LINUX_PROJECT_DIR:-$HOME/src/ironcurtain-linux}"
REPO_URL="git@github.com:provos/ironcurtain.git"

# --- Ensure the Linux clone exists ---
if [ ! -d "$LINUX_PROJECT_DIR/.git" ]; then
  echo "Linux clone not found at $LINUX_PROJECT_DIR"
  echo "Cloning from $REPO_URL ..."
  git clone "$REPO_URL" "$LINUX_PROJECT_DIR"
fi

# --- Sync current branch to the Linux clone ---
CURRENT_BRANCH="$(git -C "$MAC_PROJECT_DIR" rev-parse --abbrev-ref HEAD)"
echo "Syncing branch '$CURRENT_BRANCH' to Linux clone..."
git -C "$LINUX_PROJECT_DIR" fetch origin
git -C "$LINUX_PROJECT_DIR" checkout "$CURRENT_BRANCH" 2>/dev/null \
  || git -C "$LINUX_PROJECT_DIR" checkout -b "$CURRENT_BRANCH" "origin/$CURRENT_BRANCH" 2>/dev/null \
  || git -C "$LINUX_PROJECT_DIR" checkout -b "$CURRENT_BRANCH"
git -C "$LINUX_PROJECT_DIR" reset --hard "origin/$CURRENT_BRANCH" 2>/dev/null || true

# --- Build the dev image if needed ---
build_image() {
  echo "Building $IMAGE_NAME image..."
  docker build -t "$IMAGE_NAME" -f - "$MAC_PROJECT_DIR" <<'DOCKERFILE'
FROM docker:28-dind

# Install Node.js 22 and build tools (needed for native modules like node-pty)
RUN apk add --no-cache \
      nodejs npm \
      python3 make g++ linux-headers \
      bash sudo shadow curl git

# Install tsx globally and Aikido safe-chain
RUN npm install -g tsx @aikidosec/safe-chain

# Create a non-root dev user
RUN groupadd -g 1000 dev && useradd -m -u 1000 -g dev -s /bin/bash dev && \
    usermod -aG docker dev && \
    echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev

WORKDIR /workspace
DOCKERFILE
}

# Build if image doesn't exist or --rebuild requested
if [ "${1:-}" = "--rebuild" ]; then
  shift
  build_image
elif ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  build_image
fi

# --- Collect env vars to forward ---
# Source .env from the macOS project dir if present (don't override existing env)
if [ -f "$MAC_PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$MAC_PROJECT_DIR/.env"
  set +a
fi

ENV_ARGS=()
for var in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GOOGLE_API_KEY GITHUB_TOKEN; do
  if [ -n "${!var:-}" ]; then
    ENV_ARGS+=(-e "$var")
  fi
done

# --- Remove stale container if present ---
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "Removing existing $CONTAINER_NAME container..."
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

# --- Launch ---
echo "Starting Linux dev container (Docker-in-Docker)..."
echo "  Project: $LINUX_PROJECT_DIR -> /workspace"
echo ""

exec docker run -it --rm \
  --name "$CONTAINER_NAME" \
  --privileged \
  -e DOCKER_TLS_CERTDIR="" \
  -e DOCKER_HOST="unix:///var/run/docker.sock" \
  -v "$LINUX_PROJECT_DIR:/workspace" \
  -v "${HOME}/.ironcurtain:/home/dev/.ironcurtain" \
  ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
  "$IMAGE_NAME" \
  sh -c '
    # Start the Docker daemon in the background
    dockerd-entrypoint.sh dockerd &>/var/log/dockerd.log &

    # Wait for the daemon to be ready
    echo -n "Waiting for Docker daemon"
    for i in $(seq 1 30); do
      if docker info >/dev/null 2>&1; then
        echo " ready."
        break
      fi
      echo -n "."
      sleep 1
    done
    if ! docker info >/dev/null 2>&1; then
      echo " failed!"
      echo "Docker daemon did not start. Check /var/log/dockerd.log"
      exit 1
    fi

    # Fix workspace ownership for the dev user
    chown dev:dev /workspace 2>/dev/null || true

    # Install dependencies if node_modules is missing or has wrong platform binaries
    if [ ! -d /workspace/node_modules ] || ! su dev -c "cd /workspace && node -e \"require('"'"'node-pty'"'"')\"" 2>/dev/null; then
      echo "Installing dependencies (Linux native modules)..."
      su dev -c "cd /workspace && npm install && npm run build"
    fi

    # Create .env in workspace from forwarded env vars
    ENV_FILE=/workspace/.env
    if [ ! -f "$ENV_FILE" ]; then
      : > "$ENV_FILE"
      for var in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GOOGLE_API_KEY GITHUB_TOKEN; do
        eval val=\${$var:-}
        if [ -n "$val" ]; then
          echo "$var=$val" >> "$ENV_FILE"
        fi
      done
      chown dev:dev "$ENV_FILE"
    fi

    if [ $# -gt 0 ]; then
      exec su dev -c "cd /workspace && $*"
    else
      echo ""
      echo "=== IronCurtain Linux Dev Shell ==="
      echo "Run:  npm test              # all tests"
      echo "      npm run build         # compile TypeScript"
      echo "      npm start \"task\"      # run with a task"
      echo "      docker info           # verify Docker access"
      echo ""
      exec su dev -c "cd /workspace && exec bash --login"
    fi
  ' sh "$@"
