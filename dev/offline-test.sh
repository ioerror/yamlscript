#!/usr/bin/env bash

set -euo pipefail

dev=$(cd "$(dirname "$0")" && pwd)
node=$(ls -d "$dev"/../.cache/.local/node-*/bin | tail -1)
export PATH="$dev/../www/.venv/bin:$PATH"

make serve PORT=8000 &
server=$!
chromium --headless=new --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chromium \
  --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" \
  about:blank &>/tmp/chromium.log &

for _ in $(seq 300); do
  curl -fso /dev/null http://127.0.0.1:8000/play/ && break
  kill -0 "$server"
  sleep 2
done

"$node/node" "$dev/offline-test.mjs"
