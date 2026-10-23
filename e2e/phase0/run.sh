#!/usr/bin/env bash
# e2e/phase0/run.sh — the Phase 0 acceptance gate (WO-0.8): the Newdryve
# roadbumps as assertions against a local build. Runs in a throwaway NEAT_HOME
# with throwaway repos and a fake hosted profile on a closed port, so it never
# touches ~/.neat or a real hosted account. See README.md for the cases.
set -u
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HARNESS_DIR}/../.." && pwd)"
CORE=${CORE:-$REPO_ROOT/packages/core}
MCP=${MCP:-$REPO_ROOT/packages/mcp}
FAILED=0
NEAT="node $CORE/dist/cli.cjs"
W=$(mktemp -d /tmp/neat-wo08-XXXX)
export NEAT_HOME=$W/home NEAT_WEB_DISABLED=1 NO_COLOR=1
unset NEAT_API_URL NEAT_CORE_URL NEAT_PROFILE NEAT_PROJECT NEAT_AUTH_TOKEN NEAT_LEGACY_ROUTING
mkdir -p $NEAT_HOME
LOG=$W/log; : > $LOG
pass() { echo "PASS case $1 — $2"; }
fail() { echo "FAIL case $1 — $2"; FAILED=$((FAILED + 1)); }
skip() { echo "SKIP case $1 — $2"; }
run() { echo "\$ (cd $PWD) neat $*" >>$LOG; $NEAT "$@" >$W/out 2>$W/err; local c=$?; cat $W/out $W/err >>$LOG; echo "exit=$c" >>$LOG; return $c; }

mkrepo() {
  mkdir -p $W/$1 && cat >$W/$1/package.json <<EOF
{ "name": "$1", "version": "1.0.0", "main": "index.js", "dependencies": { "express": "^4.19.2", "pg": "^8.11.0" } }
EOF
  cat >$W/$1/index.js <<'EOF'
const express = require('express'); const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const app = express()
app.get('/users', async (_req, res) => res.json((await pool.query('select * from users')).rows))
app.listen(3000)
EOF
}
for r in repoA repoB repoH repoL; do mkrepo $r; done
pid() { jq -r .projectId $W/$1/.neat/project.json 2>/dev/null; }

# ── case 1: identity stable ─────────────────────────────────────────────
cd $W && run init repoA --no-install; c1=$?
id1=$(pid repoA); run init repoA --no-install; id2=$(pid repoA)
if [ $c1 = 0 ] && [[ $id1 =~ ^prj_[0-9A-HJKMNP-TV-Z]{26}$ ]] && [ "$id1" = "$id2" ] && [ "$(jq -r .binding $W/repoA/.neat/binding.json)" = local ]; then pass 1 "$id1 stable across re-init"; else fail 1 "id1=$id1 id2=$id2 exit=$c1"; fi
run init repoB --no-install; run init repoH --no-install

# ── case 2: pre-273 registration resolves with a notice ──────────────────
run init repoL --no-install; rm -rf $W/repoL/.neat
cd $W/repoL && run divergences; c=$?
if grep -q "run \`neat init\`" $W/err && ! grep -qi "TypeError\|stack" $W/err; then pass 2 "notice present (exit=$c: $(tail -1 $W/err))"; else fail 2 "exit=$c err=$(head -3 $W/err)"; fi

m2=$(cd $W/repoL && printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"h","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_divergences","arguments":{}}}' \
  | perl -e "alarm 30; exec @ARGV" node $MCP/dist/index.cjs 2>/dev/null | grep '"id":2')
echo "$m2" | grep -q "has no .neat/project.json yet" && pass 2b "MCP tool error carries the notice" || fail 2b "MCP: $(echo "$m2" | head -c 300)"

# ── case 3 (install/routing side): outside any project → error, no default ─
cd $W && run divergences; c=$?
if [ $c != 0 ] && grep -q "no NEAT project here" $W/err && ! grep -q "default" $W/out $W/err; then pass 3 "errors, no default"; else fail 3 "exit=$c $(head -3 $W/err)"; fi

# ── fake hosted login on a closed port (login ≠ routing) ─────────────────
cat >$NEAT_HOME/profiles.json <<EOF
{ "version": 1, "active": "hosted", "profiles": [ { "name": "hosted", "endpoint": "http://127.0.0.1:9", "authToken": "fake-token" } ] }
EOF

# ── case 4: neat up on a hosted binding ─────────────────────────────────
cd $W/repoH && run project set-hosted --org org_acme
run up; c=$?
if [ $c != 0 ] && grep -q "is hosted (runs in org_acme)" $W/err && ! grep -qi "ready" $W/out $W/err; then pass 4 "exit=$c honest message"; else fail 4 "exit=$c out=$(cat $W/out) err=$(cat $W/err)"; fi

# ── case 5: logged in + local project → local daemon ────────────────────
cd $W/repoA && run up; cu=$?
run divergences; c=$?
line=$(grep "^project=" $W/err | tail -1)
if [ $cu = 0 ] && [ $c = 0 ] && echo "$line" | grep -q "binding=local · daemon=http://localhost:" && ! grep -q "127.0.0.1:9" $W/out $W/err; then pass 5 "$line"; else fail 5 "up=$cu q=$c line=$line err=$(head -3 $W/err)"; fi
REST=$(echo "$line" | sed -n 's/.*daemon=\(http:\/\/localhost:[0-9]*\).*/\1/p')

# ── case 6: binding header on a daemon response + MCP tool result ────────
if [ -n "$REST" ]; then
  h=$(curl -s -D - -o /dev/null "$REST/health" | tr -d '\r' | grep -i '^neat-binding:')
  [ -n "$h" ] && pass 6a "daemon header: $h" || fail 6a "no neat-binding header on $REST/health"
  m=$(cd $W/repoA && printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"h","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_divergences","arguments":{}}}' \
    | perl -e "alarm 30; exec @ARGV" node $MCP/dist/index.cjs 2>$W/mcperr | grep '"id":2')
  echo "$m" >>$LOG; cat $W/mcperr >>$LOG
  r=$(cd $W/repoA && printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"h","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"neat://status"}}' \
    | perl -e "alarm 30; exec @ARGV" node $MCP/dist/index.cjs 2>/dev/null | grep '"id":3')
  echo "$r" | grep -q "binding=local" && pass 6c "neat://status carries binding line" || fail 6c "neat://status: $(echo "$r" | head -c 300)"
  echo "$m" | grep -q "binding=local" && pass 6b "MCP tool result carries binding line" || fail 6b "MCP result: $(echo "$m" | head -c 300)"
else fail 6 "no daemon from case 5"; fi

# ── case 8: connector scoped to repoA, absent in repoB ───────────────────
cd $W/repoA && run connector add railway --token '$RAILWAY_TOKEN' --skip-validate --id rw-a --environment-id env1 --service-id svc1 --service-name-by-id '{"svc1":"api"}'; ca=$?
cd $W/repoB && run connector list; c=$?
if [ $ca = 0 ] && ! grep -q "rw-a" $W/out $W/err; then pass 8 "repoB omits repoA's connector"; else fail 8 "add=$ca; repoB list: $(cat $W/out | head -5)"; fi

# ── case 9: unset $TOKEN surfaced in command output ──────────────────────
cd $W/repoA && unset RAILWAY_TOKEN && run pause repoA >/dev/null; run up; c=$?
if grep -qi "RAILWAY_TOKEN" $W/out $W/err; then pass 9 "up output names the unset credential"; else fail 9 "up exit=$c, no mention: $(cat $W/out $W/err | head -4)"; fi
run doctor; grep -qi "RAILWAY_TOKEN\|unset\|not set" $W/out $W/err && pass 9b "doctor surfaces it" || fail 9b "doctor: $(cat $W/out | head -4)"

# ── case 10t: a token piped to --token-stdin lives in the keychain only (#10) ─
# macOS only (a throwaway keychain file via NEAT_KEYCHAIN); SKIP elsewhere.
if [ "$(uname)" = Darwin ]; then
  KC=$W/test.keychain-db; security create-keychain -p pw $KC && security unlock-keychain -p pw $KC
  cd $W/repoB && printf 'phase0_secret_value\n' | NEAT_KEYCHAIN=$KC $NEAT connector add railway --token-stdin --skip-validate --id rw-b --environment-id env1 --service-id svc1 --service-name-by-id '{"svc1":"api"}' >$W/out 2>$W/err; ct=$?
  idb=$(pid repoB); ref="keychain:neat/railway/$idb"
  stored=$(security find-generic-password -s neat -a "railway/$idb" -w $KC 2>/dev/null)
  if [ $ct = 0 ] && [ "$(jq -r '.connectors[0].credential' $W/repoB/.neat/connectors.json)" = "$ref" ] && [ "$stored" = phase0_secret_value ] \
     && ! grep -rq phase0_secret_value $W/repoB/.neat $NEAT_HOME; then pass 10t "file holds $ref, secret only in the keychain"
  else fail 10t "add=$ct stored=[$stored] file=$(cat $W/repoB/.neat/connectors.json 2>/dev/null | head -c 200) err=$(cat $W/err)"; fi
  security delete-keychain $KC 2>/dev/null
else skip 10t "keychain check runs on macOS"; fi

# ── case 11 (routing side): A, B, H in one shell ─────────────────────────
cd $W/repoB && run up >/dev/null
cd $W/repoA && run divergences; la=$(grep "^project=" $W/err | tail -1)
cd $W/repoB && run divergences; lb=$(grep "^project=" $W/err | tail -1)
cd $W/repoH && run divergences; lh=$(grep "^project=" $W/err | tail -1); eh=$(head -2 $W/err)
if echo "$la" | grep -q "project=repoA.*binding=local" && echo "$lb" | grep -q "project=repoB.*binding=local" && [ "${la##*daemon=}" != "${lb##*daemon=}" ] && echo "$lh $eh" | grep -q "hosted"; then pass 11 "A/B distinct local daemons; H → hosted"; else fail 11 "A=[$la] B=[$lb] H=[$lh $eh]"; fi

# ── teardown ─────────────────────────────────────────────────────────────
for r in repoA repoB; do $NEAT pause $r >/dev/null 2>&1; done
echo "log: $LOG"
[ $FAILED = 0 ] && echo "phase0: all cases pass" || echo "phase0: $FAILED failing"
exit $FAILED
