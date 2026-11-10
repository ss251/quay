#!/bin/sh
# Unit tests, the CLI, and the sandbox suite. Sandbox starts a local node.
# Set QUAY_SKIP_SANDBOX=1 to run everything except that suite.
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

cargo test --manifest-path contract/Cargo.toml -- --test-threads=8
(cd cli && node --test)

if [ "${QUAY_SKIP_SANDBOX:-}" != "1" ]; then
  CARGO_BUILD_JOBS=1 cargo test --manifest-path contract/sandbox/Cargo.toml -- --test-threads=1
fi
