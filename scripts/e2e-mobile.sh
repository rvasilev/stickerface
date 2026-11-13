#!/usr/bin/env bash
# Touch gate: one finger works the stickers, two fingers pan the photo.
#
# Thin wrapper around scripts/e2e.sh. The driver applies the phone emulation
# itself (Emulation.setDeviceMetricsOverride + setTouchEmulationEnabled *before*
# the reload), so nothing mobile-specific happens here beyond the flag — and
# keeping ONE launcher means the Chrome flag-set fallback, the log dump and the
# teardown stay in a single place instead of drifting apart in two scripts.
#
#   npm run e2e:mobile
#   E2E_PROBE=tests/e2e/handles-probe.js npm run e2e:mobile
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export E2E_MOBILE=1
export E2E_PROBE="${E2E_PROBE:-tests/e2e/mobile-probe.js}"
exec bash "$REPO/scripts/e2e.sh" "$@"
