#!/bin/sh
# Keyless checks. Needs cargo, curl, node, shasum, and near-cli-rs on PATH.
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

rpc() {
  curl -fsS https://test.rpc.fastnear.com \
    -H 'content-type: application/json' \
    -d "$1"
}

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

echo "2. v1 production page"
body=$(curl -fsS "https://quay-bb.testnet.page/")
printf '%s\n' "$body" | grep -F "production: release" >/dev/null
echo "   saw production: release"

echo "3. v1 release 1 and its sha256"
release=$(mktemp)
curl -fsS "https://quay-bb.testnet.page/r/1" -o "$release"
grep -F "release 1" "$release" >/dev/null
got=$(shasum -a 256 "$release" | awk '{print $1}')
want=$(tr -d '[:space:]' < examples/original-demo/releases/1.sha256)
rm -f "$release"
test "$got" = "$want"
echo "   sha256 $got"

echo "4. v1 get_production"
view=$(near contract call-function as-read-only quay-bb.testnet get_production json-args '{}' network-config testnet now)
printf '%s\n' "$view"
printf '%s\n' "$view" | grep -F '"2"' >/dev/null

echo "5. product home, docs, and dashboard"
curl -fsS "https://quay-esc0v902.testnet.page/" | grep -F "Move production when you mean to" >/dev/null
curl -fsS "https://quay-esc0v902.testnet.page/docs/" | grep -F "quay deploy" >/dev/null
curl -fsS "https://quay-esc0v902.testnet.page/dashboard/" | grep -F "The page never holds a key" >/dev/null
echo "   product pages answered"

echo "6. harbour releases"
curl -fsS "https://quay-65nqd3rn.testnet.page/" | grep -F 'id="release">2' >/dev/null
curl -fsS "https://quay-65nqd3rn.testnet.page/r/1/" | grep -F 'id="release">1' >/dev/null
curl -fsS "https://quay-65nqd3rn.testnet.page/r/3/" | grep -F 'id="release">3' >/dev/null
curl -fsS "https://quay-65nqd3rn.testnet.page/mark.png" -o /dev/null
echo "   production is release 2, previews 1 and 3 are still there"

echo "7. harbour status on the RPC"
status_json=$(rpc '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"quay-65nqd3rn.testnet","method_name":"get_status","args_base64":"e30=","finality":"final"}}')
node -e '
const data = JSON.parse(process.argv[1]);
const text = Buffer.from(data.result.result).toString("utf8");
if (!text.includes("\"version\":\"2.0.0\"")) process.exit(1);
if (!text.includes("\"production\":\"2\"")) process.exit(1);
if (!text.includes("\"previous\":\"3\"")) process.exit(1);
' "$status_json"
echo "   version 2.0.0, production 2, previous 3"

echo "8. publish-only promote was refused"
refusal=$(rpc '{"jsonrpc":"2.0","id":"1","method":"tx","params":{"tx_hash":"8efXfntramSDtXuWpA87kAWpsMwYQPo7QUzwPo6AuM4G","sender_account_id":"quay-65nqd3rn.testnet","wait_until":"NONE"}}')
printf '%s\n' "$refusal" | grep -E 'MethodNameMismatch|does not allow method' >/dev/null
echo "   8efXfntramSDtXuWpA87kAWpsMwYQPo7QUzwPo6AuM4G refused promote"

echo "judge checks passed"
