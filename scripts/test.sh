#!/bin/sh
# Unit tests, the CLI, and the sandbox suites. Each sandbox suite starts one
# local node and stops it when it ends.
# Set QUAY_SKIP_SANDBOX=1 to run everything except that suite.
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

cargo test --manifest-path contract/Cargo.toml -- --test-threads=8
cargo test --manifest-path functions/Cargo.toml
(cd cli && node --test)
(cd gateway && node --test)
(cd client && node --test)

if [ "${QUAY_SKIP_SANDBOX:-}" != "1" ]; then
  CARGO_BUILD_JOBS=1 cargo test --manifest-path contract/sandbox/Cargo.toml -- --test-threads=1
  # The JS suites start one local node each, one after the other. They need
  # client/node_modules (npm install in client/); without it they are skipped.
  if [ -d client/node_modules/near-sandbox ]; then
    (cd client && QUAY_SANDBOX=1 node --test test/sandbox.test.mjs)
    (cd cli && QUAY_SANDBOX=1 node --test test/sandbox.test.mjs)
  else
    echo "skipped the JS sandbox suites: run npm install in client/"
  fi
fi
