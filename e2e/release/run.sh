#!/usr/bin/env bash
# e2e/release/run.sh — is main releasable? Packs every publishable package from
# the current build, installs the tarballs together into an empty directory the
# way a user's `npm i` would (install scripts on, so native modules build), and
# runs e2e/phase0 against the INSTALLED bins rather than the source tree. Does
# not publish anything.
#
#   npx turbo build --concurrency=1
#   ./e2e/release/run.sh                       # with the node on PATH
#   NODE_DIRS="/path/node-v20.0.0/bin /path/node-v22.12.0/bin" ./e2e/release/run.sh
#
# Each NODE_DIRS entry is a Node bin directory (node + npm); the install and the
# harness both run under it. Exit code = number of Node versions that failed.
set -u
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HARNESS_DIR}/../.." && pwd)"
PACKAGES="types core mcp neat.is claude-skill otel-node instrumentation-registry web"
NODE_DIRS=${NODE_DIRS:-$(dirname "$(command -v node)")}
W=$(mktemp -d /tmp/neat-release-XXXX)
FAILED=0

mkdir -p "$W/tgz"
for p in $PACKAGES; do
  (cd "$REPO_ROOT/packages/$p" && npm pack --silent --pack-destination "$W/tgz" >/dev/null 2>&1) || {
    echo "FAIL pack — packages/$p (is it built?)"
    exit 1
  }
done
echo "packed: $(ls "$W/tgz" | tr '\n' ' ')"

for bin in $NODE_DIRS; do
  v=$("$bin/node" -v)
  D="$W/install-$v"
  mkdir -p "$D"
  (cd "$D" && PATH="$bin:/usr/bin:/bin" npm init -y >/dev/null && PATH="$bin:/usr/bin:/bin" npm i "$W"/tgz/*.tgz --no-audit --no-fund) >"$D/install.log" 2>&1
  ic=$?
  if [ $ic != 0 ] || grep -q EBADENGINE "$D/install.log"; then
    echo "FAIL $v — install exit=$ic $(grep -m1 -E 'EBADENGINE|npm (ERR|error)' "$D/install.log")"
    FAILED=$((FAILED + 1))
    continue
  fi
  installed=$(PATH="$bin:/usr/bin:/bin" "$D/node_modules/.bin/neat" --version 2>&1 | head -1)
  PATH="$bin:$PATH" CORE="$D/node_modules/@neat.is/core" MCP="$D/node_modules/@neat.is/mcp" \
    bash "$REPO_ROOT/e2e/phase0/run.sh" >"$D/phase0.log" 2>&1
  hc=$?
  if [ $hc = 0 ]; then
    echo "PASS $v — installed neat $installed, phase0 all cases pass"
  else
    echo "FAIL $v — installed neat $installed, phase0: $(grep -E '^FAIL' "$D/phase0.log" | cut -c1-120 | tr '\n' ';')"
    FAILED=$((FAILED + 1))
  fi
done
echo "logs: $W"
exit $FAILED
