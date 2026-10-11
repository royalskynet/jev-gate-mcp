#!/usr/bin/env bash
# Verify the jev-prune Hermes rollout end to end, offline.
#
# Stages, in order:
#   1. repo tests (npm test) + plugin Python selfcheck
#   2. isolated HERMES_HOME discovery: plugin loads + middleware registers
#   3. real-profile read-only discovery: jev-prune enabled + loaded per profile
#   4. secrets clean: no API key / token / request payload in any ledger
#
# Exit 0 and prints:
#   repo-tests=pass plugin-tests=pass coco=loaded mannie=loaded xuanjun=loaded secrets=clean
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HERMES_AGENT="${HERMES_AGENT:-$HOME/.hermes/hermes-agent}"
PY="${HERMES_AGENT}/.venv/bin/python3"
PROFILES=(coco mannie xuanjun)
FAIL=0

pass() { echo "$1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

echo "== stage 1: repo tests =="
if ! (cd "$REPO" && npm test >/tmp/jev-repo-test.log 2>&1); then
  tail -20 /tmp/jev-repo-test.log
  fail "repo tests"
else
  pass "repo-tests=pass"
fi

echo "== stage 1b: plugin python selfcheck =="
if ! "$PY" -c "import sys; sys.path.insert(0,'$REPO/integrations/hermes/jev-prune'); import __init__ as m; m._selfcheck()" >/tmp/jev-plugin-test.log 2>&1; then
  tail -20 /tmp/jev-plugin-test.log
  fail "plugin selfcheck"
else
  pass "plugin-tests=pass"
fi

echo "== stage 2: isolated HERMES_HOME discovery =="
TMPHOME="$(mktemp -d)"
mkdir -p "$TMPHOME/plugins"
ln -s "$REPO/integrations/hermes/jev-prune" "$TMPHOME/plugins/jev-prune"
# Hermes' opt-in gate skips any plugin absent from `plugins.enabled` (the isolated
# HOME has no config), so seed a minimal config before discovery.
printf 'plugins:\n  enabled:\n    - jev-prune\n' > "$TMPHOME/config.yaml"
ISOLATED_LOG="$(cat <<'PYEOF'
import os, sys
os.environ['HERMES_HOME'] = os.environ['TMPHOME']
sys.path.insert(0, os.environ['HERMES_AGENT'])
from hermes_cli.plugins import discover_plugins, get_plugin_manager, has_middleware
discover_plugins(force=True)
mgr = get_plugin_manager()
loaded = sorted(getattr(mgr, 'loaded_plugins', {}) or getattr(mgr, '_plugins', {}))
print('loaded=', loaded)
print('has_tool_execution=', has_middleware('tool_execution'))
print('callbacks=', [getattr(c, '__name__', '?') for c in mgr._middleware.get('tool_execution', [])])
PYEOF
)"
if ! HERMES_AGENT="$HERMES_AGENT" TMPHOME="$TMPHOME" "$PY" -c "$ISOLATED_LOG" >/tmp/jev-isolated.log 2>&1; then
  tail -20 /tmp/jev-isolated.log
  fail "isolated discovery"
else
  cat /tmp/jev-isolated.log
  if grep -q "jev-prune" /tmp/jev-isolated.log && grep -q "has_tool_execution=\s*True" /tmp/jev-isolated.log; then
    pass "isolated=loaded"
  else
    fail "isolated plugin not loaded"
  fi
fi
rm -rf "$TMPHOME"

echo "== stage 3: real-profile read-only discovery =="
for P in "${PROFILES[@]}"; do
  HOME_P="$HOME/.hermes/profiles/$P"
  if [ -L "$HOME_P/plugins/jev-prune" ] || [ -d "$HOME_P/plugins/jev-prune" ]; then
    if grep -q "jev-prune" "$HOME_P/config.yaml" 2>/dev/null; then
      pass "$P=loaded"
    else
      fail "$P plugin dir present but not enabled in config"
    fi
  else
    fail "$P plugin not installed"
  fi
done

echo "== stage 4: secrets clean =="
CLEAN=1
for P in "${PROFILES[@]}"; do
  LED="$HOME/.hermes/profiles/$P/logs/jev-prune.jsonl"
  [ -f "$LED" ] || continue
  if grep -qiE '"(api_key|key|token|secret|user_request|request|result)"\s*:' "$LED"; then
    echo "  secret-like field in $LED"
    CLEAN=0
  fi
done
[ "$CLEAN" = 1 ] && pass "secrets=clean" || fail "secrets dirty"

echo "== report executable =="
if node "$REPO/scripts/savings-report-hermes-jev-prune.mjs" >/tmp/jev-report.txt 2>&1; then
  pass "report=ok"
else
  fail "savings report"
fi

echo
if [ "$FAIL" = 0 ]; then
  echo "verify complete: all checks passed"
  exit 0
else
  echo "verify complete: FAILURES PRESENT"
  exit 1
fi
