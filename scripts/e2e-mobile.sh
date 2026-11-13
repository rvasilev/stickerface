#!/usr/bin/env bash
# Mobile acceptance gate: emulated touch device (390x844, dsf 2), real touch
# events via CDP Input.dispatchTouchEvent, measured from canvas pixels.
#
#   ./scripts/e2e-mobile.sh                 # the mobile gesture probe
#   ./scripts/e2e-mobile.sh tests/e2e/other-probe.js [port] [cdp-port]
#
# Exit code is the probe's: 0 = every criterion passed.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE="${1:-tests/e2e/mobile-probe.js}"
HTTP_PORT="${2:-8181}"
CDP_PORT="${3:-9261}"
CHROME_BIN="${CHROME_BIN:-$(command -v google-chrome-stable || command -v chromium || command -v chromium-browser)}"
PROFILE="$(mktemp -d /tmp/sf-chrome-m-XXXXXX)"

[ -x "$CHROME_BIN" ] || { echo "e2e-mobile: no Chrome/Chromium found (set CHROME_BIN)" >&2; exit 2; }
[ -f "$REPO/tests/e2e/fixture.jpg" ] || python3 "$REPO/scripts/make-fixture.py"

SERVER_PID=""
CHROME_PID=""
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  wait 2>/dev/null
  for _ in 1 2 3 4 5; do rm -rf "$PROFILE" 2>/dev/null && break; sleep 0.3; done
}
trap cleanup EXIT

( cd "$REPO" && python3 -m http.server "$HTTP_PORT" >/tmp/sf-e2e-m-http.log 2>&1 ) &
SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -sf -o /dev/null "http://127.0.0.1:${HTTP_PORT}/index.html" && break
  sleep 0.3
done

# A phone-shaped window; the driver then applies a true mobile metrics override
# (390x844, deviceScaleFactor 2, touch) before the page loads.
"$CHROME_BIN" --headless=new --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --disable-gpu --disable-dev-shm-usage --window-size=900,1400 \
  "http://127.0.0.1:${HTTP_PORT}/index.html" >/tmp/sf-e2e-m-chrome.log 2>&1 &
CHROME_PID=$!
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:${CDP_PORT}/json/version" && break
  sleep 0.5
done
sleep 1.5

echo "e2e-mobile: probe=$PROBE http=$HTTP_PORT cdp=$CDP_PORT"
( cd "$REPO" && E2E_MOBILE=1 CDP_HTTP="http://127.0.0.1:${CDP_PORT}" \
    python3 tests/e2e/run.py "$PROBE" "$HTTP_PORT" )
CODE=$?
echo "E2E_MOBILE_EXIT=$CODE"
exit $CODE
