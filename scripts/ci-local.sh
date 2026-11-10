#!/bin/sh
# Run the composite action's steps outside GitHub.
# Set QUAY_ACCOUNT and QUAY_CI_KEY in the environment. Do not pass the key
# as an argument, and do not print it. A publish-only key must fail promote.
set -eu
dir=${1:?directory to deploy}
if [ -z "${QUAY_ACCOUNT:-}" ] || [ -z "${QUAY_CI_KEY:-}" ]; then
  echo "Set QUAY_ACCOUNT and QUAY_CI_KEY on the environment. Do not pass the key as an argument."
  exit 1
fi
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
prefix=${QUAY_PREFIX:-$(mktemp -d)}
npm install --prefix "$prefix" "$root/cli" >/dev/null
export PATH="$prefix/node_modules/.bin:$PATH"
quay deploy "$dir" --message "${QUAY_MESSAGE:-ci preview}" --ci --yes --json
set +e
quay promote 1 --ci --yes
code=$?
set -e
if [ "$code" != 3 ]; then
  echo "promote exited $code. A publish-only key must exit 3."
  exit 1
fi
echo "promote refused with exit 3"
