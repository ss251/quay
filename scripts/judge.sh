#!/bin/sh
# Keyless checks. Needs cargo, curl, node, and shasum on PATH.
#
# Every page fetch tries three hosts in order and prints which one answered:
#   1. the Cloudflare Workers mirror listed in web/hosts.json, when the account has one
#   2. https://<name>.testnet.page
#   3. a local `quay gateway` for that account, started on a free port and stopped on exit
# A host is skipped when it does not answer, answers 5xx, or answers with JSON-RPC
# error JSON (the deprecated-RPC outage). The choice is made per request, because
# hosted gateways flap.
# QUAY_JUDGE_LOCAL=1 uses only the local gateway. QUAY_JUDGE_NO_MIRROR=1 skips the Workers mirrors.
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

# mirror_for <account>: the Workers mirror URL from web/hosts.json, or nothing.
mirror_for() {
  node -e 'const h=require("./web/hosts.json");const m=h.mirrors[process.argv[1]];if(m)console.log(m.replace(/\/$/,""))' "$1"
}

# try_host <label> <url> <timeout>: 0 when the host gave a usable answer.
try_host() {
  code=$(curl -sS -m "$3" -o "$work/body" -w '%{http_code}' "$2" 2>"$work/err") || code=000
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
    echo "   $1 $2 -> $code"
    return 0
  fi
  echo "   $1 $2 failed ($reason)"
  return 1
}

# fetch <account> <path>: body in $work/body, status in $work/code.
fetch() {
  account=$1
  path=$2
  if [ "${QUAY_JUDGE_LOCAL:-}" != "1" ]; then
    if [ "${QUAY_JUDGE_NO_MIRROR:-}" != "1" ]; then
      mirror=$(mirror_for "$account")
      if [ -n "$mirror" ] && try_host workers "$mirror$path" 30; then return 0; fi
    fi
    if try_host public "https://${account%.testnet}.testnet.page$path" 30; then return 0; fi
    echo "   falling back to the local gateway"
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

echo "7. gateway layer"
# The gateway is the code that turns a browser GET into a web4_get view call. It runs
# as the Workers mirror, as testnet.page, and as `quay gateway`; any one answering is enough.
gateway_ok=""
mirror=$(mirror_for quay-esc0v902.testnet)
if [ "${QUAY_JUDGE_LOCAL:-}" != "1" ] && [ -n "$mirror" ] && curl -fsS -m 30 -D "$work/headers" -o "$work/body" "$mirror/_quay/health" 2>/dev/null &&
  grep -F '"ok":true' "$work/body" >/dev/null && grep -i '^x-quay-gateway: quay' "$work/headers" >/dev/null; then
  gateway_ok="workers $mirror/_quay/health"
else
  port=$(local_port quay-esc0v902.testnet)
  curl -fsS -m 30 "http://127.0.0.1:$port/_quay/health" | grep -F '"ok":true' >/dev/null
  gateway_ok="local http://127.0.0.1:$port/_quay/health"
fi
echo "   quay gateway answered ($gateway_ok)"

echo "8. what the live contracts report"
for account in quay-esc0v902.testnet quay-65nqd3rn.testnet; do
  version_json=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"account_id\":\"$account\",\"method_name\":\"get_version\",\"args_base64\":\"e30=\",\"finality\":\"final\"}}")
  node -e '
const data = JSON.parse(process.argv[1]);
const v = JSON.parse(Buffer.from(data.result.result).toString("utf8"));
if (v.standard !== "quay") process.exit(1);
console.log("   " + process.argv[2] + " contract " + v.version);
' "$version_json" "$account"
done

echo "9. Harbour Board, the full-stack sample on harbour-board.testnet"
# Contract 3.x with data, routes, members, functions, payments and a large file.
# Pages come from its Workers mirror, then testnet.page, then a local gateway.
board=harbour-board.testnet

# view <method> <args json>: the JSON text a view call on the board returns.
view() {
  args=$(printf '%s' "$2" | base64 | tr -d '\n')
  rpc "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"account_id\":\"$board\",\"method_name\":\"$1\",\"args_base64\":\"$args\",\"finality\":\"final\"}}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.result)process.exit(1);process.stdout.write(Buffer.from(j.result.result).toString("utf8"))})'
}

# check <json> <js expression over d> <message>: fail unless the expression is true.
check() {
  if ! node -e 'const d=JSON.parse(process.argv[1]);if(!(eval(process.argv[2])))process.exit(1)' "$1" "$2"; then
    echo "   failed: $3" >&2
    exit 1
  fi
}

contract=$(view get_version '{}')
check "$contract" 'd.version.startsWith("3.")' "board contract is 3.x"
echo "   contract $(echo "$contract" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"

echo "   data and routes"
check "$(view list_collections '{}')" 'd.some(c=>c.name==="posts"&&c.on_add==="moderate"&&c.payer==="site"&&c.moderated)' "posts collection with on_add moderate"
fetch "$board" /
expect_code 200
expect "Harbour digest"
expect "Digest of posts"
cp "$work/body" "$work/home"
fetch "$board" /api/posts
expect_code 200
expect '"docs":['
node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (d.docs.length < 5) process.exit(1);
if (d.docs.some((doc) => doc.id === "9" || doc.hidden)) process.exit(1);
' "$work/body"
fetch "$board" /posts/9
expect_code 404
if grep -F 'href="/posts/9"' "$work/home" >/dev/null; then
  echo "   the hidden spam post 9 is listed on /" >&2
  exit 1
fi
check "$(view db_get '{"collection":"posts","id":"9"}')" 'd.hidden===true' "posts/9 is hidden by the moderate function"
echo "   server-rendered / and /api/posts answer, hidden spam post 9 is absent and /posts/9 is 404"

echo "   payments and pins"
check "$(view list_receipts '{"limit":10}')" 'd.receipts.length>=2&&d.receipts.some(r=>r.token==="near")&&d.receipts.some(r=>r.token==="usdc.fakes.testnet")' "a NEAR receipt and a test-USDC receipt"
pinned=$(view db_get '{"collection":"posts","id":"6"}')
# A pin lasts 24 hours, so the order check only holds while the pin is live.
if node -e 'const d=JSON.parse(process.argv[1]);process.exit(d.pinned_until&&BigInt(d.pinned_until)>BigInt(Date.now())*1000000n?0:1)' "$pinned"; then
  node -e '
const html = require("fs").readFileSync(process.argv[1], "utf8");
const at = (id) => html.indexOf(`href="/posts/${id}"`);
if (!(at(6) > 0 && at(6) < at(5) && at(5) < at(15))) process.exit(1);
' "$work/home"
  echo "   2 receipts (NEAR and test USDC); pinned posts 6 and 5 come before post 15 on /"
else
  echo "   2 receipts (NEAR and test USDC); the 24 hour pins have expired, so the pinned-first order check is skipped"
fi

echo "   members"
check "$(view list_members '{"from_index":0,"limit":50}')" 'd.members.length>=6&&d.members.every(m=>m.endsWith(".harbour-board.testnet"))' "at least 6 members"
check "$(view is_member '{"account":"maren.harbour-board.testnet"}')" 'd===true' "maren is a member"
echo "   at least 6 members, created with no NEAR"

echo "   functions"
check "$(view fn_list '{}')" 'd.some(f=>f.name==="moderate"&&f.secrets)&&d.some(f=>f.name==="digest")' "moderate (with a secret) and digest registered"
check "$(view db_list '{"collection":"_fn","query":{"prefix":"digest-","limit":1}}')" 'd.docs.length===1&&d.docs[0].data.ok===true&&d.docs[0].data.output.title' "a digest result in _fn"
check "$(view db_list '{"collection":"_fn","query":{"prefix":"moderate-","limit":5}}')" 'd.docs.some(x=>x.data.ok&&x.data.output.auth==="ok")' "a moderate result with auth ok"
echo "   moderate and digest registered; both have results on chain"

echo "   large file"
release=$(view get_release '{"id":"4"}')
sha=16cca45160bd57f293b580dc754cf8313cdc41cbcb7d982c4696bbf5c9f38ccf
check "$release" "d.files.some(f=>f.path==='assets/img/harbour.png'&&f.external&&f.external.sha256==='$sha'&&f.external.url.startsWith('https://test.fastfs.io/'))" "release 4 holds the hero as an external https file"
fetch "$board" /assets/img/harbour.png
expect_code 200
test "$(shasum -a 256 "$work/body" | cut -d' ' -f1)" = "$sha"
echo "   hero photo, 493,183 bytes on FastFS, served through the gateway with sha256 $sha"

echo "   cron"
check "$(view cron_list '{}')" 'd.some(j=>j.name==="digest"&&j.every_minutes===60)' "digest job set"
armed=$(view cron_status '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).armed?"armed":"set but not armed"))')
echo "   the digest job is set, chain $armed now (one arm lasts about 6 hours)"
check "$(view db_list '{"collection":"_fn","query":{"prefix":"digest-","limit":50,"order":"desc"}}')" 'd.docs.some(x=>x.data.ok&&x.data.output&&x.data.output.scheduled===true)' "a scheduled run wrote a digest"
echo "   a scheduled run wrote a digest (ok, scheduled: true in _fn)"

# Not checked here: wallet sign-in needs a person and a wallet (see examples/board/LIVE.md);
# Pinata and Filebase and Circle USDC are not proven. See README, Full-stack layers.
echo "   not checked here: wallet sign-in (needs a wallet), Pinata and Filebase, Circle USDC"

echo "judge checks passed"
