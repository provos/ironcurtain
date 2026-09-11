#!/bin/sh
# The only root phase initializes a fresh root-owned named volume. No chown,
# host workspace mutation, extra capability, or user-specific image is needed.
set -eu
root=/run/ironcurtain-docker
uid=$(id -u rootless)
gid=$(id -g rootless)
[ "$(id -u)" = 0 ]
[ "$uid" != 0 ]
[ "$gid" != 0 ]
[ "$(stat -c '%u:%g:%a' "$root")" = 0:0:755 ]
[ ! -e "$root/docker" ]
chmod 0733 "$root"
su -s /bin/sh -c 'umask 077; mkdir /run/ironcurtain-docker/docker' rootless
# The shared state volume is also a parent of the BuildKit executor tree. Its
# trusted FD walk opens each ancestor read-only; namespace root needs directory
# read permission here. Private child contents still require the selected identity.
chmod 0755 "$root"
[ "$(stat -c '%u:%g:%a' "$root/docker")" = "$uid:$gid:700" ]
exec su -s /bin/sh -- rootless -c 'exec dockerd-entrypoint.sh "$@"' ironcurtain-daemon "$@"
