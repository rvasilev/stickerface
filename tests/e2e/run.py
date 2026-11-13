#!/usr/bin/env python3
"""Minimal Chrome DevTools Protocol driver for the StickerFace E2E probe.

Why hand-rolled: no Playwright/Puppeteer is installed here, and the Hermes CDP
tool refuses loopback page URLs. `websockets` is enough to drive a headless
Chrome that was started with --remote-debugging-port.

Usage:
  # 1. serve the app
  python3 -m http.server 8123
  # 2. headless chrome pointed at it (start it with the URL as an argument)
  google-chrome-stable --headless=new --remote-debugging-port=9222 \
      --user-data-dir=/tmp/sf-chrome --no-first-run --disable-gpu \
      "http://127.0.0.1:8123/index.html"
  # 3. run a probe
  python3 tests/e2e/run.py tests/e2e/probe.js

Exit code is 0 when the probe returned a result; the probe's own PASS/FAIL keys
carry the assertions.
"""
import asyncio
import json
import os
import sys
import urllib.request

import websockets

# Override to drive a second Chrome (e.g. one pointed at the deployed site).
CDP_HTTP = os.environ.get("CDP_HTTP", "http://127.0.0.1:9222")


def page_target(match="8123"):
    with urllib.request.urlopen(f"{CDP_HTTP}/json/list") as r:
        for t in json.load(r):
            if t.get("type") == "page" and match in t.get("url", ""):
                return t
    raise SystemExit(f"no page target whose url contains {match}")


async def main(probe_path, url_match="8123"):
    # RELATIVE, not root-absolute: the app is served at the origin root locally
    # but under /stickerface/ on GitHub Pages, where '/tests/...' would resolve to
    # the origin root and return a 404 HTML page (evaluated as "Unexpected token <").
    probe = probe_path.lstrip("/")
    target = page_target(url_match)
    events = []
    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024) as ws:
        counter = 0

        async def send(method, params=None):
            nonlocal counter
            counter += 1
            mid = counter
            await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == mid:
                    return msg
                events.append(msg)

        await send("Runtime.enable")
        await send("Page.enable")
        await send("Page.reload", {"ignoreCache": True})
        await asyncio.sleep(2.5)

        # top-level await is illegal in a classic script, hence the async wrapper.
        # Cache-buster: GitHub Pages' CDN caches static files (~10 min), so a
        # freshly pushed probe.js would otherwise run the PREVIOUS revision.
        expr = (
            "(async () => await eval(await (await fetch("
            f"'{probe}?cb=' + Date.now(), {{cache: 'no-store'}})).text()))()"
        )
        res = await send(
            "Runtime.evaluate",
            {"expression": expr, "awaitPromise": True, "returnByValue": True, "timeout": 60000},
        )

        # Two-phase probes: a probe may return `nextDrag: {x0,y0,x1,y1}` plus install
        # `window.__sfRead()` to report the outcome. Handle drags MUST use real input
        # (Input.dispatchMouseEvent) — a synthetic dispatchEvent pointerdown has no
        # active pointer, so `setPointerCapture` throws and the drag never starts.
        drag_result = None
        try:
            first = json.loads(res["result"]["result"].get("value") or "{}")
        except Exception:
            first = {}
        plan = first.get("nextDrag") if isinstance(first, dict) else None
        if plan:
            x0, y0, x1, y1 = plan["x0"], plan["y0"], plan["x1"], plan["y1"]
            base = {"button": "left", "buttons": 1, "clickCount": 1, "pointerType": "mouse"}
            await send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x0, "y": y0, "buttons": 0})
            await send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0, **base})
            steps = 8
            for i in range(1, steps + 1):
                await send("Input.dispatchMouseEvent", {
                    "type": "mouseMoved",
                    "x": x0 + (x1 - x0) * i / steps,
                    "y": y0 + (y1 - y0) * i / steps,
                    **base,
                })
                await asyncio.sleep(0.03)
            await send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x1, "y": y1, **base})
            await asyncio.sleep(0.4)
            read = await send("Runtime.evaluate", {
                "expression": "window.__sfRead ? window.__sfRead() : null",
                "awaitPromise": True, "returnByValue": True, "timeout": 20000,
            })
            drag_result = read["result"]["result"].get("value")

        try:
            while True:
                events.append(json.loads(await asyncio.wait_for(ws.recv(), timeout=0.4)))
        except Exception:
            pass

    problems = []
    for e in events:
        m = e.get("method")
        if m == "Runtime.exceptionThrown":
            d = e["params"]["exceptionDetails"]
            desc = d.get("exception", {}).get("description", "")
            problems.append(f"EXCEPTION {d.get('text')} {desc[:300]}")
        elif m == "Runtime.consoleAPICalled" and e["params"].get("type") in ("error", "warning"):
            args = " ".join(str(a.get("value", a.get("description", ""))) for a in e["params"]["args"])
            problems.append(f"CONSOLE {e['params']['type']}: {args[:300]}")

    print("=== console / uncaught exceptions ===")
    print("\n".join(problems) if problems else "(none)")

    result = res.get("result", {}).get("result", {})
    if result.get("subtype") == "error":
        print("=== eval failed ===")
        print(json.dumps(res["result"])[:1500])
        return 1

    print("=== probe result ===")
    value = result.get("value")
    if not value:
        print(json.dumps(res)[:1500])
        return 1
    data = json.loads(value)
    if isinstance(data, dict) and "steps" in data:
        for k, v in data["steps"]:
            print(f"{k}: {json.dumps(v)}")
        for e in data.get("errors", []):
            print("PROBE ERROR: " + e)
    else:
        print(json.dumps(data, indent=1))

    # Acceptance criteria are TOP-LEVEL boolean keys; steps are just the evidence.
    checks = {}
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, bool):
                checks[k] = v

    # Phase-2 (real-input drag) results, when the probe asked for one.
    if drag_result:
        try:
            second = json.loads(drag_result)
        except Exception:
            second = None
        if isinstance(second, dict):
            print("=== drag phase ===")
            for k, v in second.get("steps", []):
                print(f"{k}: {json.dumps(v)}")
            for e in second.get("errors", []):
                print("DRAG ERROR: " + e)
            for k, v in second.items():
                if isinstance(v, bool):
                    checks[k] = v
        else:
            print("=== drag phase ===")
            print(str(drag_result)[:800])

    print("=== checks ===")
    for k, v in checks.items():
        print(f"  {'PASS' if v else 'FAIL'}  {k}")
    failed = [k for k, v in checks.items() if not v]
    if not checks:
        print("  (probe reported no boolean criteria — fix the probe)")
        return 1
    print(f"=== {len(checks) - len(failed)}/{len(checks)} passed ===")
    return 1 if failed else 0


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "tests/e2e/probe.js"
    match = sys.argv[2] if len(sys.argv) > 2 else "8123"
    sys.exit(asyncio.run(main(path, match)))
