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


def print_step(step):
    """Print one probe `steps` entry. The contract is a [label, value] pair, but a
    probe that pushes more is a probe bug worth SEEING rather than a traceback that
    takes the whole result set down with it."""
    if isinstance(step, list) and step:
        label, rest = step[0], step[1:]
        print(f"{label}: " + " ".join(json.dumps(x) for x in rest))
    else:
        print(json.dumps(step))


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

        # Mobile emulation must be applied BEFORE the reload so layout, media
        # queries and touch behaviour are the ones a phone sees.
        mobile = os.environ.get("E2E_MOBILE") == "1"
        if mobile:
            await send("Emulation.setDeviceMetricsOverride", {
                "width": int(os.environ.get("E2E_MOBILE_W", "390")),
                "height": int(os.environ.get("E2E_MOBILE_H", "844")),
                "deviceScaleFactor": 2,
                "mobile": True,
            })
            await send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})

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
        rotate_result = None
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
            # Optional second drag (rotate): the resize reader may have armed
            # window.__sfNextRotate + window.__sfReadRotate.
            rotate_plan = await send("Runtime.evaluate", {
                "expression": "window.__sfNextRotate ? JSON.stringify(window.__sfNextRotate) : null",
                "awaitPromise": True, "returnByValue": True, "timeout": 20000,
            })
            rotate_json = rotate_plan["result"]["result"].get("value")
            if rotate_json:
                try:
                    rplan = json.loads(rotate_json)
                except Exception:
                    rplan = None
                if rplan:
                    rx0, ry0, rx1, ry1 = rplan["x0"], rplan["y0"], rplan["x1"], rplan["y1"]
                    await send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": rx0, "y": ry0, "buttons": 0})
                    await send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": rx0, "y": ry0, **base})
                    for i in range(1, steps + 1):
                        await send("Input.dispatchMouseEvent", {
                            "type": "mouseMoved",
                            "x": rx0 + (rx1 - rx0) * i / steps,
                            "y": ry0 + (ry1 - ry0) * i / steps,
                            **base,
                        })
                        await asyncio.sleep(0.03)
                    await send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": rx1, "y": ry1, **base})
                    await asyncio.sleep(0.4)
                    read2 = await send("Runtime.evaluate", {
                        "expression": "window.__sfReadRotate ? window.__sfReadRotate() : null",
                        "awaitPromise": True, "returnByValue": True, "timeout": 20000,
                    })
                    rotate_result = read2["result"]["result"].get("value")

        # Touch phase: a probe may arm `window.__sfNextInput` with a list of
        # touch steps, then report through `window.__sfReadTouch()`. Real touch
        # events only exist via CDP Input.dispatchTouchEvent (and only when touch
        # emulation is on), so gesture behaviour cannot be tested from page JS.
        touch_result = None
        touch_json = await send("Runtime.evaluate", {
            "expression": "window.__sfNextInput ? JSON.stringify(window.__sfNextInput) : null",
            "awaitPromise": True, "returnByValue": True, "timeout": 20000,
        })
        touch_steps = touch_json["result"]["result"].get("value")
        if touch_steps:
            try:
                steps = json.loads(touch_steps)
            except Exception:
                steps = None
            if steps:
                # Real browsers give every touch contact a unique, monotonically
                # increasing pointerId. Handing out 0/1 again for each gesture
                # lets a second gesture reuse an id the app may still believe is
                # down, which reads as "two fingers" forever -- a harness artifact
                # that would blame the app for the probe's own bookkeeping.
                next_touch_id = 100
                active_ids = []

                def ids_for(n):
                    nonlocal next_touch_id
                    while len(active_ids) < n:
                        active_ids.append(next_touch_id)
                        next_touch_id += 1
                    return active_ids[:n]

                for step in steps:
                    kind = step.get("t")
                    pts = step.get("pts") or []
                    if kind == "settle":
                        await asyncio.sleep(float(step.get("ms", 200)) / 1000)
                        continue
                    if kind == "read":
                        # mid-sequence measurement: the page writes into
                        # window.__sfSnaps under this name; the final reader
                        # returns all snapshots.
                        await send("Runtime.evaluate", {
                            "expression": f"window.__sfSnap && window.__sfSnap({json.dumps(step.get('name', 'snap'))})",
                            "awaitPromise": True, "returnByValue": True, "timeout": 20000,
                        })
                        continue
                    if kind in ("click", "move", "hold"):
                        # Real mouse input: a double click MUST come through the
                        # browser (clickCount 1 then 2) — a synthetic `dblclick`
                        # event proves nothing about the handler being wired.
                        # `hold` keeps the button DOWN for holdMs before releasing,
                        # which is the only way to observe interval-driven repeat:
                        # a click releases before any repeat can fire.
                        # `fns` resolves the point from the PAGE at dispatch time —
                        # a disclosure that closes moves its OWN summary (the panel's
                        # scroll clamps to the shorter content), so a point measured
                        # before the first click lands on whatever slid into that spot
                        # for the second one.
                        if step.get("fns"):
                            rr = await send("Runtime.evaluate", {
                                "expression": step["fns"][0], "awaitPromise": True,
                                "returnByValue": True, "timeout": 20000,
                            })
                            v = rr["result"]["result"].get("value")
                            if not isinstance(v, list) or len(v) < 2:
                                print(f"{kind}: fns returned {v!r}")
                                continue
                            pts = [(float(v[0]), float(v[1]))]
                        x, y = pts[0]
                        if kind == "move":
                            await send("Input.dispatchMouseEvent", {
                                "type": "mouseMoved", "x": x, "y": y, "button": "none",
                            })
                        else:
                            count = int(step.get("count", 1))
                            await send("Input.dispatchMouseEvent", {
                                "type": "mouseMoved", "x": x, "y": y, "button": "none",
                            })
                            await send("Input.dispatchMouseEvent", {
                                "type": "mousePressed", "x": x, "y": y, "button": "left",
                                "buttons": 1, "clickCount": count,
                            })
                            if kind == "hold":
                                await asyncio.sleep(float(step.get("holdMs", 900)) / 1000)
                            await send("Input.dispatchMouseEvent", {
                                "type": "mouseReleased", "x": x, "y": y, "button": "left",
                                "buttons": 0, "clickCount": count,
                            })
                        await asyncio.sleep(float(step.get("ms", 60)) / 1000)
                        continue
                    if kind == "key":
                        # modifiers: alt=1 ctrl=2 meta=4 shift=8
                        await send("Input.dispatchKeyEvent", {
                            "type": "keyDown", "modifiers": int(step.get("modifiers", 0)),
                            "key": step.get("key", ""), "code": step.get("code", ""),
                            "windowsVirtualKeyCode": int(step.get("vk", 0)),
                            "nativeVirtualKeyCode": int(step.get("vk", 0)),
                            "text": step.get("text", ""),
                        })
                        await send("Input.dispatchKeyEvent", {
                            "type": "keyUp", "modifiers": int(step.get("modifiers", 0)),
                            "key": step.get("key", ""), "code": step.get("code", ""),
                            "windowsVirtualKeyCode": int(step.get("vk", 0)),
                            "nativeVirtualKeyCode": int(step.get("vk", 0)),
                        })
                        await asyncio.sleep(float(step.get("ms", 80)) / 1000)
                        continue
                    if kind == "tapPagePoint":
                        # A tap whose point is computed by the PAGE at dispatch
                        # time (e.g. an "emptiest spot" that depends on the current
                        # pan). fn must return [x, y] in viewport CSS px.
                        ptp = await send("Runtime.evaluate", {
                            "expression": step.get("fn", "null"),
                            "awaitPromise": True, "returnByValue": True, "timeout": 20000,
                        })
                        val = ptp["result"]["result"].get("value")
                        if isinstance(val, list) and len(val) >= 2:
                            p = [{"x": val[0], "y": val[1], "radiusX": 8, "radiusY": 8, "force": 1, "id": 900}]
                            await send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": p})
                            await asyncio.sleep(0.07)
                            await send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                        else:
                            print(f"tapPagePoint: page returned {val!r}")
                        await asyncio.sleep(float(step.get("ms", 200)) / 1000)
                        continue
                    if kind == "drag":
                        # A real button-held drag with interpolated moves. The
                        # top-level plan supports only two drags per probe, and a
                        # handle drag needs a genuine pointer (setPointerCapture
                        # throws without one) — `modifiers` carries Shift through
                        # the whole gesture. `fns` resolves each endpoint from the
                        # PAGE at dispatch time: a handle that moves with the
                        # rotation cannot be addressed by coordinates computed
                        # before the gesture.
                        if step.get("fns"):
                            live = []
                            for fn in step["fns"]:
                                rr = await send("Runtime.evaluate", {
                                    "expression": fn, "awaitPromise": True,
                                    "returnByValue": True, "timeout": 20000,
                                })
                                v = rr["result"]["result"].get("value")
                                if not isinstance(v, list) or len(v) < 2:
                                    print(f"drag: fns returned {v!r}")
                                    live = None
                                    break
                                live.append((float(v[0]), float(v[1])))
                            if live is None:
                                continue
                            pts = live
                        (dx0, dy0), (dx1, dy1) = pts[0], pts[1]
                        mods = int(step.get("modifiers", 0))
                        n = int(step.get("steps", 8))
                        base = {"button": "left", "buttons": 1, "clickCount": 1, "modifiers": mods}
                        await send("Input.dispatchMouseEvent", {
                            "type": "mouseMoved", "x": dx0, "y": dy0, "button": "none", "modifiers": mods,
                        })
                        await send("Input.dispatchMouseEvent", {
                            "type": "mousePressed", "x": dx0, "y": dy0, **base,
                        })
                        for i in range(1, n + 1):
                            await send("Input.dispatchMouseEvent", {
                                "type": "mouseMoved", "modifiers": mods, "buttons": 1,
                                "x": dx0 + (dx1 - dx0) * i / n,
                                "y": dy0 + (dy1 - dy0) * i / n,
                            })
                            await asyncio.sleep(0.02)
                        await send("Input.dispatchMouseEvent", {
                            "type": "mouseReleased", "x": dx1, "y": dy1, **base,
                        })
                        await asyncio.sleep(float(step.get("ms", 150)) / 1000)
                        continue
                    touch_points = [
                        {"x": p[0], "y": p[1], "radiusX": 8, "radiusY": 8, "force": 1, "id": pid}
                        for pid, p in zip(ids_for(len(pts)), pts)
                    ]
                    if kind == "touchStart":
                        await send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": touch_points})
                    elif kind == "touchMove":
                        await send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": touch_points})
                    elif kind == "touchEnd":
                        await send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": touch_points})
                        del active_ids[len(pts):]
                    await asyncio.sleep(float(step.get("ms", 60)) / 1000)
                await asyncio.sleep(0.5)
                # Optional post-gesture hook (e.g. an export whose result the
                # reader needs) must run before the reader.
                await send("Runtime.evaluate", {
                    "expression": "window.__sfFinishZoom ? window.__sfFinishZoom() : null",
                    "awaitPromise": True, "returnByValue": True, "timeout": 30000,
                })
                read3 = await send("Runtime.evaluate", {
                    "expression": "window.__sfReadTouch ? window.__sfReadTouch() : null",
                    "awaitPromise": True, "returnByValue": True, "timeout": 20000,
                })
                touch_result = read3["result"]["result"].get("value")
                if not touch_result:
                    # A reader that throws is otherwise dropped in silence: the
                    # phase contributes no criteria, the probe still prints a
                    # check list, and a MISSING criterion reads as "not tested"
                    # only if someone counts. Report it as a failed reader.
                    res3 = read3.get("result", {}).get("result", {})
                    detail = res3.get("description") or json.dumps(res3)[:400]
                    print("=== touch phase: READER FAILED ===")
                    print(detail)

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
        for step in data["steps"]:
            print_step(step)
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

    # Phase-2 (real-input) results: drag / rotate (mouse) and touch.
    for label, raw in (("drag phase", drag_result), ("rotate phase", rotate_result),
                       ("touch phase", touch_result)):
        if not raw:
            continue
        try:
            second = json.loads(raw)
        except Exception:
            second = None
        if isinstance(second, dict):
            print(f"=== {label} ===")
            for step in second.get("steps", []):
                print_step(step)
            for e in second.get("errors", []):
                print("PHASE ERROR: " + e)
            for k, v in second.items():
                if isinstance(v, bool):
                    checks[k] = v
        else:
            print(f"=== {label} ===")
            print(str(raw)[:800])

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
