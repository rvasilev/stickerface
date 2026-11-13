#!/usr/bin/env bash
# Self-contained acceptance gate: serve the repo, start headless Chrome, run the
# browser probe, tear everything down. Zero manual steps.
#
#   ./scripts/e2e.sh                          # the user journey, working tree
#   ./scripts/e2e.sh https://example.com      # against a deployed URL (skips the server)
#   E2E_PROBE=tests/e2e/delete-probe.js ./scripts/e2e.sh   # any probe, same harness
#
# Any probe in tests/e2e/ can be run through this script -- no ad-hoc runner in
# /tmp is needed, which is what made these gates reproducible from a clean clone.
#
# Exit code is the probe's: 0 = every criterion passed.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
PROBE="${E2E_PROBE:-tests/e2e/probe.js}"
HTTP_PORT="${HTTP_PORT:-8123}"
CDP_PORT="${CDP_PORT:-9222}"
CHROME_BIN="${CHROME_BIN:-$(command -v google-chrome-stable || command -v chromium || command -v chromium-browser)}"
PROFILE="$(mktemp -d /tmp/sf-chrome-XXXXXX)"

[ -f "$REPO/$PROBE" ] || { echo "e2e: probe not found: $PROBE" >&2; exit 2; }
[ -x "$CHROME_BIN" ] || { echo "e2e: no Chrome/Chromium found (set CHROME_BIN)" >&2; exit 2; }
[ -f "$REPO/tests/e2e/fixture.jpg" ] || python3 "$REPO/scripts/make-fixture.py"

SERVER_PID=""
CHROME_PID=""
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  wait 2>/dev/null
  # Chrome flushes its profile on exit; retry briefly so the temp dir goes away.
  for _ in 1 2 3 4 5; do rm -rf "$PROFILE" 2>/dev/null && break; sleep 0.3; done
}
trap cleanup EXIT

if [ -z "$TARGET" ]; then
  ( cd "$REPO" && python3 -m http.server "$HTTP_PORT" >/tmp/sf-e2e-http.log 2>&1 ) &
  SERVER_PID=$!
  TARGET="http://127.0.0.1:${HTTP_PORT}/index.html"
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "http://127.0.0.1:${HTTP_PORT}/index.html" && break
    sleep 0.3
  done
  MATCH="$HTTP_PORT"
else
  MATCH="$(printf '%s' "$TARGET" | sed -E 's#^https?://([^/]+).*#\1#')"
fi

# The URL must be on the command line: CDP Page.navigate refuses loopback targets.
"$CHROME_BIN" --headless=new --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --disable-gpu --disable-dev-shm-usage --window-size=1400,1000 \
  "$TARGET" >/tmp/sf-e2e-chrome.log 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:${CDP_PORT}/json/version" && break
  sleep 0.5
done
sleep 1.5   # let the app boot before the probe reloads it

echo "e2e: target=$TARGET probe=$PROBE cdp=$CDP_PORT mobile=${E2E_MOBILE:-0}"
( cd "$REPO" && E2E_MOBILE="${E2E_MOBILE:-0}" CDP_HTTP="http://127.0.0.1:${CDP_PORT}" \
    python3 tests/e2e/run.py "$PROBE" "$MATCH" )
CODE=$?
echo "E2E_EXIT=$CODE"
exit $CODE
