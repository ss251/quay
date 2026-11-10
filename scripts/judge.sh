#!/bin/sh
# Keyless checks. Needs cargo, curl, and near-cli-rs on PATH.
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

echo "1. cargo test"
log=$(mktemp)
set +e
cargo test --manifest-path contract/Cargo.toml -- --test-threads=8 >"$log"
status=$?
set -e
cat "$log"
grep -F "sealed_release_bytes_stick" "$log" >/dev/null
grep -F "publish_key_cannot_promote" "$log" >/dev/null
rm -f "$log"
test "$status" = 0

echo "2. production page"
body=$(curl -fsS "https://quay-bb.testnet.page/")
printf '%s\n' "$body" | grep -F "production: release" >/dev/null
echo "   saw production: release"

echo "3. release 1 and its sha256"
release=$(mktemp)
curl -fsS "https://quay-bb.testnet.page/r/1" -o "$release"
grep -F "release 1" "$release" >/dev/null
got=$(shasum -a 256 "$release" | awk '{print $1}')
want=$(tr -d '[:space:]' < releases/1.sha256)
rm -f "$release"
test "$got" = "$want"
echo "   sha256 $got"

echo "4. get_production"
view=$(near view quay-bb.testnet get_production '{}' --network-id testnet)
printf '%s\n' "$view"
printf '%s\n' "$view" | grep -F '"2"' >/dev/null

echo "judge checks passed"
