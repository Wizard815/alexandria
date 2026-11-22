#!/bin/sh
# Start as root only long enough to make /data writable (a bind-mounted ./data
# that Docker created is owned by root), then run the server as the unprivileged
# "node" user. Started with --user, it runs as given and changes nothing.
set -e
if [ "$(id -u)" = "0" ]; then
  d="${ALX_DATA_DIR:-/data}"
  mkdir -p "$d"
  [ "$(stat -c %u "$d")" = "$(id -u node)" ] || chown -R node:node "$d"
  exec su-exec node "$@"
fi
exec "$@"
