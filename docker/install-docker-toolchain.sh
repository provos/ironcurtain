#!/bin/sh
# Assemble the same toolchain tree for both agent image bases. Run in the
# selected Docker source stage, so architecture follows that stage's platform.
set -eu

destination="${1:?usage: install-docker-toolchain.sh DESTINATION}"
case "$destination" in
  /*) ;;
  *) echo 'toolchain destination must be absolute' >&2; exit 1 ;;
esac
if [ -e "$destination" ]; then
  echo 'toolchain destination must not already exist' >&2
  exit 1
fi

toolchain="$destination/usr/local/lib/ironcurtain-docker/bin"
plugins="$destination/usr/local/libexec/docker/cli-plugins"
preferredPlugins="$destination/usr/local/lib/docker/cli-plugins"
mkdir -p "$toolchain" "$plugins" "$preferredPlugins" "$destination/usr/local/bin"
cp -a /usr/local/bin/. "$toolchain/"
cp -a /usr/local/libexec/docker/cli-plugins/. "$plugins/"
ln -s /usr/local/lib/ironcurtain-docker/bin/docker "$destination/usr/local/bin/docker"
ln -s /usr/sbin/iptables-legacy "$toolchain/iptables"
# The universal base can contain plugins in this higher-priority discovery
# directory. Override those two entries with links to the shared installation.
for plugin in docker-buildx docker-compose; do
  ln -s "/usr/local/libexec/docker/cli-plugins/$plugin" "$preferredPlugins/$plugin"
done

# Normalize inherited source ownership. This is predictable installation
# metadata, not an authority boundary: the agent can administer its image via sudo.
chown -R 0:0 "$destination"

# Check the source tools now, before the assembled tree is copied into either base.
docker --version
docker buildx version
docker compose version --short
test -x "$toolchain/docker"
test -x "$plugins/docker-buildx"
test -x "$plugins/docker-compose"
