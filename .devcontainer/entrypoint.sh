#!/usr/bin/env bash
set -euo pipefail

install -d -o vscode -g vscode /deno-dir /home/vscode/.cache
chown -R vscode:vscode /deno-dir /home/vscode/.cache

if [[ -S /var/run/docker.sock ]]; then
  socket_gid="$(stat --format=%g /var/run/docker.sock)"
  socket_group="$(getent group "${socket_gid}" | cut --delimiter=: --fields=1 || true)"
  if [[ -z "${socket_group}" ]]; then
    socket_group=docker-host
    groupadd --gid "${socket_gid}" "${socket_group}"
  fi
  usermod --append --groups "${socket_group}" vscode
fi

exec setpriv --reuid=vscode --regid=vscode --init-groups "$@"
