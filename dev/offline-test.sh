#!/usr/bin/env bash

set -euo pipefail

dev=$(cd "$(dirname "$0")" && pwd)
node=$(ls -d "$dev"/../.cache/.local/node-*/bin | tail -1)

make deps
PYTHONPATH=$PWD/python .venv/bin/mkdocs build --quiet --site-dir /tmp/site
chromium --headless=new --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chromium \
  --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" \
  about:blank &>/tmp/chromium.log &

"$node/node" "$dev/offline-test.mjs" /tmp/site
