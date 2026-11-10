#!/bin/sh
# Keyless checks. Needs cargo, curl, node, and shasum on PATH.
#
# Every page fetch tries https://<name>.testnet.page first. When that fails, or
# answers with the deprecated-RPC JSON, the same path is fetched from a local
# `quay gateway` for that account, started on a free port and stopped on exit.
# The choice is made per request, because the public gateway flaps.
# QUAY_JUDGE_LOCAL=1 skips the public gateway and uses only the local one.
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

work=$(mktemp -d)
# local_port runs in a command substitution, so gateway pids go in a file.
cleanup() {
  if [ -f "$work/pids" ]; then
    while read -r pid; do kill "$pid" 2>/dev/null || true; done <"$work/pids"
  fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

rpc() {
  curl -fsS https://test.rpc.fastnear.com \
    -H 'content-type: application/json' \
    -d "$1"
}

free_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

# Starts `quay gateway` for an account once per run; prints its port.
local_port() {
  file="$work/port-$1"
  if [ ! -f "$file" ]; then
    port=$(free_port)
    node cli/bin/quay.js gateway --account "$1" --port "$port" >"$work/gateway-$1.log" 2>&1 &
    echo "$!" >>"$work/pids"
    tries=0
    until curl -fsS -o /dev/null "http://127.0.0.1:$port/_quay/health" 2>/dev/null; do
      tries=$((tries + 1))
      if [ "$tries" -gt 40 ]; then
        echo "   the local gateway for $1 did not start:" >&2
        cat "$work/gateway-$1.log" >&2
        exit 1
      fi
      sleep 0.5
    done
    echo "$port" >"$file"
  fi
  cat "$file"
}

# fetch <account> <path>: body in $work/body, status in $work/code.
fetch() {
  account=$1
  path=$2
  public="https://${account%.testnet}.testnet.page$path"
  if [ "${QUAY_JUDGE_LOCAL:-}" != "1" ]; then
    code=$(curl -sS -m 30 -o "$work/body" -w '%{http_code}' "$public" 2>"$work/err") || code=000
    reason=""
    if [ "$code" = 000 ]; then
      reason="no answer: $(head -c 120 "$work/err")"
    elif grep -q 'THIS ENDPOINT IS DEPRECATED' "$work/body"; then
      reason="HTTP $code, deprecated RPC"
    elif [ "$code" -ge 500 ] || { [ "$code" -ge 400 ] && grep -q '"jsonrpc"' "$work/body"; }; then
      reason="HTTP $code"
    fi
    if [ -z "$reason" ]; then
      echo "$code" >"$work/code"
      echo "   public $public -> $code"
      return 0
    fi
    echo "   public $public failed ($reason), using the local gateway"
  fi
  port=$(local_port "$account")
  url="http://127.0.0.1:$port$path"
  code=$(curl -sS -m 60 -o "$work/body" -w '%{http_code}' "$url") || code=000
  echo "$code" >"$work/code"
  echo "   local  $url -> $code"
}

# expect <text>: the last fetched body contains <text>.
expect() {
  if ! grep -F -- "$1" "$work/body" >/dev/null; then
    echo "   expected \"$1\" in that page" >&2
    exit 1
  fi
}

# expect_code <status>: the last fetch answered <status>.
expect_code() {
  if [ "$(cat "$work/code")" != "$1" ]; then
    echo "   expected HTTP $1, got $(cat "$work/code")" >&2
    exit 1
  fi
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
fetch quay-bb.testnet /
expect_code 200
expect "production: release"
echo "   quay-bb.testnet still serves"

echo "3. product home, docs, and dashboard"
fetch quay-esc0v902.testnet /
expect_code 200
expect "Move production on purpose"
expect "2.3151 NEAR"
fetch quay-esc0v902.testnet /docs/
expect_code 200
expect "quay deploy"
expect "gateway certificate"
fetch quay-esc0v902.testnet "/dashboard/?account=quay-65nqd3rn.testnet"
expect_code 200
expect "Try the sample"
echo "   product pages answered"

echo "4. harbour releases"
fetch quay-65nqd3rn.testnet /
expect_code 200
expect 'id="release">5'
fetch quay-65nqd3rn.testnet /berth/
expect_code 200
expect "Berth"
fetch quay-65nqd3rn.testnet /chart.svg
expect_code 200
expect "<svg"
fetch quay-65nqd3rn.testnet /r/1/
expect_code 200
expect 'id="release">1'
fetch quay-65nqd3rn.testnet /r/3/
expect_code 200
expect 'id="release">3'
fetch quay-65nqd3rn.testnet /missing
expect_code 404
expect "Not on this release"
echo "   production is release 5, older previews and the 404 still answer"

echo "5. harbour status on the RPC"
status_json=$(rpc '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","account_id":"quay-65nqd3rn.testnet","method_name":"get_status","args_base64":"e30=","finality":"final"}}')
node -e '
const data = JSON.parse(process.argv[1]);
const text = Buffer.from(data.result.result).toString("utf8");
if (!text.includes("\"version\":\"2.0.0\"")) process.exit(1);
if (!text.includes("\"production\":\"5\"")) process.exit(1);
if (!text.includes("\"previous\":\"4\"")) process.exit(1);
' "$status_json"
echo "   version 2.0.0, production 5, previous 4"

echo "6. publish-only promote was refused"
refusal=$(rpc '{"jsonrpc":"2.0","id":"1","method":"tx","params":{"tx_hash":"58YRcXZZZMPrmNgNCpEm4ssTWC6sCM73we6wKKD9smTT","sender_account_id":"quay-i7qkbbp3.testnet","wait_until":"NONE"}}')
printf '%s\n' "$refusal" | grep -E 'MethodNameMismatch|does not allow method' >/dev/null
echo "   58YRcXZZZMPrmNgNCpEm4ssTWC6sCM73we6wKKD9smTT refused promote"

echo "judge checks passed"
