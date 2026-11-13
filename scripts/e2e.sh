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
#
# Flag sets are tried in order because headless Chrome is not one thing across
# environments: a `chrome-headless-shell` / Chromium build ABORTS on
# `--headless=new` (observed on a GitHub runner: "Aborted (core dumped)"), while
# some sandboxed containers need `--no-sandbox`. Whichever set answers on the CDP
# port wins, and the Chrome log is printed when none does — an unexplained
# ConnectionRefused is otherwise a 40-line traceback pointing nowhere.
CHROME_PID=""
start_chrome() {
  # $@ = extra flags
  "$CHROME_BIN" "$@" --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
    --disable-gpu --disable-dev-shm-usage --window-size=1400,1000 \
    "$TARGET" >>/tmp/sf-e2e-chrome.log 2>&1 &
  CHROME_PID=$!
  for _ in $(seq 1 24); do
    curl -sf -o /dev/null "http://127.0.0.1:${CDP_PORT}/json/version" && return 0
    kill -0 "$CHROME_PID" 2>/dev/null || return 1   # died: try the next set
    sleep 0.5
  done
  return 1
}

: >/tmp/sf-e2e-chrome.log
LOGIN_SET=""
for flags in "--headless=new" "--headless=new --no-sandbox" "--headless --no-sandbox" "--headless"; do
  # shellcheck disable=SC2086
  if start_chrome $flags; then LOGIN_SET="$flags"; break; fi
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null
  CHROME_PID=""
  sleep 0.5
done
if [ -z "$LOGIN_SET" ]; then
  echo "e2e: Chrome never opened the CDP port on 127.0.0.1:${CDP_PORT}." >&2
  echo "e2e: binary=$CHROME_BIN  tried: --headless=new, +--no-sandbox, --headless" >&2
  echo "--- /tmp/sf-e2e-chrome.log (last 30 lines) ---" >&2
  tail -30 /tmp/sf-e2e-chrome.log >&2
  exit 2
fi
echo "e2e: chrome flags = $LOGIN_SET"
sleep 1.5   # let the app boot before the probe reloads it

echo "e2e: target=$TARGET probe=$PROBE cdp=$CDP_PORT mobile=${E2E_MOBILE:-0}"
( cd "$REPO" && E2E_MOBILE="${E2E_MOBILE:-0}" CDP_HTTP="http://127.0.0.1:${CDP_PORT}" \
    python3 tests/e2e/run.py "$PROBE" "$MATCH" )
CODE=$?
echo "E2E_EXIT=$CODE"
exit $CODE
