#!/bin/sh
# Build the site and the sample app. The contract wasm is rebuilt only when
# QUAY_REBUILD_WASM=1, and only one cargo job runs.
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

if [ "${QUAY_REBUILD_WASM:-}" = "1" ]; then
  (cd contract && CARGO_BUILD_JOBS=1 cargo near build non-reproducible-wasm)
  cp contract/target/near/quay.wasm cli/vendor/quay.wasm
fi

node web/build.mjs

if [ ! -d examples/harbour/node_modules ]; then
  (cd examples/harbour && npm install)
fi
(cd examples/harbour && npm run build)
