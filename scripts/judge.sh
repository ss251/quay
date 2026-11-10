#!/bin/sh
# Keyless checks. Needs cargo, curl, node, and shasum on PATH.
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

echo "2. the old demo still answers"
body=$(curl -fsS "https://quay-bb.testnet.page/")
printf '%s\n' "$body" | grep -F "production: release" >/dev/null
echo "   https://quay-bb.testnet.page/ still serves"

echo "3. product home, docs, and dashboard"
curl -fsS "https://quay-esc0v902.testnet.page/" | grep -F "Move production when you mean to" >/dev/null
curl -fsS "https://quay-esc0v902.testnet.page/" | grep -F "2.3151 NEAR" >/dev/null
curl -fsS "https://quay-esc0v902.testnet.page/docs/" | grep -F "quay deploy" >/dev/null
curl -fsS "https://quay-esc0v902.testnet.page/docs/" | grep -F "gateway certificate" >/dev/null
curl -fsS "https://quay-esc0v902.testnet.page/dashboard/?account=quay-65nqd3rn.testnet" | grep -F "Try the sample" >/dev/null
echo "   product pages answered"

echo "4. harbour releases"
curl -fsS "https://quay-65nqd3rn.testnet.page/" | grep -F 'id="release">4' >/dev/null
curl -fsS "https://quay-65nqd3rn.testnet.page/berth/" | grep -F "Berth" >/dev/null
curl -fsS "https://quay-65nqd3rn.testnet.page/chart.svg" | grep -F "<svg" >/dev/null
curl -fsS "https://quay-65nqd3rn.testnet.page/r/1/" | grep -F 'id="release">1' >/dev/null
curl -fsS "https://quay-65nqd3rn.testnet.page/r/3/" | grep -F 'id="release">3' >/dev/null
missing=$(mktemp)
code=$(curl -sS -o "$missing" -w "%{http_code}" "https://quay-65nqd3rn.testnet.page/missing")
test "$code" = "404"
grep -F "Not on this release" "$missing" >/dev/null
rm -f "$missing"
echo "   production is release 4, older previews and the 404 still answer"

echo "5. harbour status on the RPC"
status_json=$(rpc '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"quay-65nqd3rn.testnet","method_name":"get_status","args_base64":"e30=","finality":"final"}}')
node -e '
const data = JSON.parse(process.argv[1]);
const text = Buffer.from(data.result.result).toString("utf8");
if (!text.includes("\"version\":\"2.0.0\"")) process.exit(1);
if (!text.includes("\"production\":\"4\"")) process.exit(1);
if (!text.includes("\"previous\":\"2\"")) process.exit(1);
' "$status_json"
echo "   version 2.0.0, production 4, previous 2"

echo "6. publish-only promote was refused"
refusal=$(rpc '{"jsonrpc":"2.0","id":"1","method":"tx","params":{"tx_hash":"58YRcXZZZMPrmNgNCpEm4ssTWC6sCM73we6wKKD9smTT","sender_account_id":"quay-i7qkbbp3.testnet","wait_until":"NONE"}}')
printf '%s\n' "$refusal" | grep -E 'MethodNameMismatch|does not allow method' >/dev/null
echo "   58YRcXZZZMPrmNgNCpEm4ssTWC6sCM73we6wKKD9smTT refused promote"

echo "judge checks passed"
