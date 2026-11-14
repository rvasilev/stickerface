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
import urllib.parse
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

        async def send_fresh(method, params=None, timeout=8):
            """One-shot CDP call on its OWN connection to the same page target.

            The long-lived socket above is closed by this Chrome (157.0.8103.50) once the
            probe phase finishes: every attempt after it raises ConnectionClosedOK with code
            1000, two attempts in a row, with no watchdog killing Chrome (checked in
            scripts/e2e.sh). So any CDP work that happens AFTER the probe — the
            installability check here, and the offline phase's reload/emulate — dials a
            fresh connection instead. Verified on this Chrome: a fresh connection to the
            same target answers Page.getInstallabilityErrors normally.
            """
            async with websockets.connect(target["webSocketDebuggerUrl"], max_size=8 << 20) as w:
                await w.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
                while True:
                    msg = json.loads(await asyncio.wait_for(w.recv(), timeout=timeout))
                    if msg.get("id") == 1:
                        return msg

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
                        # `button` lets a step drive the MIDDLE button: CDP carries it
                        # as button 'middle' + buttons 4, and the app's pan path keys
                        # off `ev.button === 1`, which a hardcoded 'left' can never
                        # reach.
                        btn = step.get("button", "left")
                        btns = 4 if btn == "middle" else 1
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
                                "type": "mousePressed", "x": x, "y": y, "button": btn,
                                "buttons": btns, "clickCount": count,
                            })
                            if kind == "hold":
                                await asyncio.sleep(float(step.get("holdMs", 900)) / 1000)
                            await send("Input.dispatchMouseEvent", {
                                "type": "mouseReleased", "x": x, "y": y, "button": btn,
                                "buttons": 0, "clickCount": count,
                            })
                        await asyncio.sleep(float(step.get("ms", 60)) / 1000)
                        continue
                    if kind == "wheel":
                        # A real wheel event. `deltaMode` cannot be sent through CDP at
                        # all, which is why the line/page normalisation is covered by a
                        # unit test instead of here.
                        x, y = pts[0]
                        mods = int(step.get("modifiers", 0))
                        await send("Input.dispatchMouseEvent", {
                            "type": "mouseMoved", "x": x, "y": y, "button": "none", "modifiers": mods,
                        })
                        await send("Input.dispatchMouseEvent", {
                            "type": "mouseWheel", "x": x, "y": y,
                            "deltaX": float(step.get("deltaX", 0)),
                            "deltaY": float(step.get("deltaY", -100)),
                            "modifiers": mods,
                        })
                        await asyncio.sleep(float(step.get("ms", 80)) / 1000)
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
                        # `button` too: a middle-button DRAG is how the pan path is
                        # exercised, and a hardcoded 'left' cannot reach it.
                        dbtn = step.get("button", "left")
                        base = {"button": dbtn, "buttons": 4 if dbtn == "middle" else 1,
                                "clickCount": 1, "modifiers": mods}
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
                    if step.get("fns"):
                        # `fns` resolves each touch point from the PAGE at
                        # dispatch time, as the mouse steps already do. A touch
                        # gesture aimed at an element an EARLIER gesture moved
                        # needs this: a point captured at arm time lands where
                        # the element used to be, and the gesture then silently
                        # does something else — or nothing at all, which reads as
                        # an app defect rather than a stale aim.
                        resolved = []
                        for fn_expr in step["fns"]:
                            rr = await send("Runtime.evaluate", {
                                "expression": fn_expr, "awaitPromise": True,
                                "returnByValue": True, "timeout": 20000,
                            })
                            v = rr["result"]["result"].get("value")
                            if not isinstance(v, list) or len(v) < 2:
                                print(f"{kind}: fns returned {v!r}")
                                resolved = []
                                break
                            resolved.append((float(v[0]), float(v[1])))
                        if resolved:
                            pts = resolved
                    if kind == "touchAdd":
                        # Adding a finger to a LIVE gesture. CDP's touchStart must
                        # carry ONLY the new points: re-sending an already-active
                        # point makes the whole event invalid and Chromium drops
                        # it, so the second finger never registers — the app sees
                        # one pointer, the gesture silently stays a one-finger
                        # drag, and the probe blames the app for its own aim.
                        base = len(active_ids)
                        new_ids = ids_for(base + len(pts))[base:]
                        await send("Input.dispatchTouchEvent", {
                            "type": "touchStart",
                            "touchPoints": [
                                {"x": p[0], "y": p[1], "radiusX": 8, "radiusY": 8, "force": 1, "id": pid}
                                for pid, p in zip(new_ids, pts)
                            ],
                        })
                        await asyncio.sleep(float(step.get("ms", 60)) / 1000)
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

    # An exception or a console ERROR fails the run. The definition of done says this
    # section must print "(none)", and a green run that printed one anyway would be
    # certifying a broken console. Warnings stay advisory — a Chrome deprecation
    # notice is not a defect in this app — but they are still printed.
    hard, soft = [], []
    for e in events:
        m = e.get("method")
        if m == "Runtime.exceptionThrown":
            d = e["params"]["exceptionDetails"]
            desc = d.get("exception", {}).get("description", "")
            hard.append(f"EXCEPTION {d.get('text')} {desc[:300]}")
        elif m == "Runtime.consoleAPICalled" and e["params"].get("type") in ("error", "warning"):
            args = " ".join(str(a.get("value", a.get("description", ""))) for a in e["params"]["args"])
            line = f"CONSOLE {e['params']['type']}: {args[:300]}"
            (hard if e["params"]["type"] == "error" else soft).append(line)
    problems = hard + soft

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

    # Phase-2 (real-input) results: drag / rotate (mouse) and touch. A phase that ran
    # but contributed NO criteria is the dangerous shape: its criteria vanish, the run
    # still prints a full-looking check list, and the omission is visible only to
    # someone who counts. Every shortfall is named and failed.
    failures = []
    for label, raw in (("drag phase", drag_result), ("rotate phase", rotate_result),
                       ("touch phase", touch_result)):
        if not raw:
            continue
        try:
            second = json.loads(raw)
        except Exception as err:
            failures.append(f"{label}: unparseable result ({err})")
            print(f"=== {label} ===")
            print(str(raw)[:800])
            continue
        if not isinstance(second, dict):
            failures.append(f"{label}: result is not an object")
            print(f"=== {label} ===")
            print(str(raw)[:800])
            continue
        print(f"=== {label} ===")
        for step in second.get("steps", []):
            print_step(step)
        for e in second.get("errors", []):
            print("PHASE ERROR: " + e)
            failures.append(f"{label}: {str(e)[:200]}")
        for k, v in second.items():
            if isinstance(v, bool):
                checks[k] = v
        # NOTE: a phase that reports steps but NO booleans is NOT a failure. Most
        # probes use their touch/drag phase as an input DRIVER and assert the result
        # in the main reader, so steps-without-criteria is the normal shape (ten of
        # the twenty CI gates do it). An earlier version of this check inferred a
        # thrown reader from the absent booleans and failed all ten. The catches that
        # do hold are above: a non-empty `errors` array, an unparseable or non-object
        # result, and (mobile) no result at all.
    if os.environ.get("E2E_MOBILE") == "1" and not touch_result:
        failures.append("touch phase: no result at all")

    # The install criteria page JS cannot observe: ask the BROWSER whether it would install
    # this app. Guarded by an env flag so every existing gate's output is unchanged.
    installability = []
    if os.environ.get("E2E_INSTALLABILITY") == "1":
        print(f"=== long-lived socket: close_code={ws.close_code} ===")
        payload = {}
        read_ok = False
        for attempt in (1, 2):
            try:
                got = await send_fresh("Page.getInstallabilityErrors")
                payload = got.get("result", {})
                # The key must be PRESENT for this to count as a read: an empty or missing
                # payload is an unknown, and an unknown must never read as "no errors".
                read_ok = isinstance(payload, dict) and "installabilityErrors" in payload
                print(f"=== INSTALLABILITY (attempt {attempt}, read_ok={read_ok}) ===")
                print("  raw: " + json.dumps(payload)[:600])
                if read_ok:
                    break
            except Exception as exc:
                print(f"=== INSTALLABILITY attempt {attempt} failed: {type(exc).__name__}: {exc} ===")
            await asyncio.sleep(0.3)
        if not read_ok:
            failures.append("installability could not be read from the browser")
        errs = (payload.get("installabilityErrors") or []) if read_ok else []
        for err in errs:
            if isinstance(err, dict):
                installability.append(err.get("errorId") or json.dumps(err)[:200])
            else:
                installability.append(str(err))
        checks["installabilityErrorsEmpty"] = read_ok and not installability
        if installability:
            print("=== INSTALLABILITY ERRORS ===")
            for e in installability:
                print("  " + str(e))

    # Optional offline phase: prove the app BOOTS from its own cache with no network at all.
    #
    # Two constraints shape this, both discovered by reading the harness rather than assumed:
    #  * A reload is the only thing that proves a navigation is served from cache, and a
    #    reload destroys the first probe's page state — so the criteria come from a SECOND
    #    probe, evaluated fresh afterwards.
    #  * That second probe CANNOT be loaded by fetch once the network is cut, so its source
    #    is captured while still online and evaluated from memory. (The first probe's own
    #    loader is a `fetch(probe + '?cb=' + Date.now())`; offline that is a guaranteed
    #    failure, and a cache-busted URL is by design not in the cache.)
    #
    # One connection for the whole phase, on purpose: it must stay open to collect Network
    # events, and the harness's long-lived socket is already closed by this point (see
    # send_fresh). It is how "nothing left the origin" is checked.
    offline_path = os.environ.get("E2E_PROBE_OFFLINE")
    if offline_path:
        try:
            async with websockets.connect(target["webSocketDebuggerUrl"], max_size=64 << 20) as ows:
                onet = [0]
                net = []

                async def osend(method, params=None, timeout=30):
                    onet[0] += 1
                    mid = onet[0]
                    await ows.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
                    while True:
                        msg = json.loads(await asyncio.wait_for(ows.recv(), timeout=timeout))
                        if msg.get("id") == mid:
                            return msg
                        if msg.get("method") == "Network.requestWillBeSent":
                            net.append(msg["params"]["request"]["url"])

                await osend("Network.enable")

                async def ev(expression, timeout=30, await_promise=True):
                    got = await osend("Runtime.evaluate", {
                        "expression": expression, "awaitPromise": await_promise,
                        "returnByValue": True, "timeout": timeout * 1000,
                    })
                    return got.get("result", {}).get("result", {}).get("value")

                # Deterministic start, on purpose. Chrome's harness profile persists between
                # runs, so without this the PREVIOUS run's cache masks any change to what gets
                # precached: a mutation that removes the shell from the list then passes while
                # doing nothing. Cleared and unregistered, the install below is a genuine
                # first install.
                await ev("(async () => {"
                         " await Promise.all((await caches.keys()).map((n) => caches.delete(n)));"
                         " await Promise.all((await navigator.serviceWorker.getRegistrations())"
                         "   .map((r) => r.unregister()));"
                         " return true; })()", timeout=20)

                # Seed BEFORE the worker's first activation, or the cleanup rule cannot be
                # observed at all: activate() runs once, and a cache created after it is never
                # considered. Both seeds exist to be deleted or spared by that single cleanup —
                # a stale version of this app (must go) and a neighbouring app on the same
                # origin (must stay; user.github.io hosts many, so an unscoped delete wipes a
                # neighbour's offline data).
                await ev("(async () => {"
                         " const stale = await caches.open('sf-v0');"
                         " await stale.put('/stale', new Response('an older version'));"
                         " const neighbour = await caches.open('other-repo-v1');"
                         " await neighbour.put('/other', new Response('a neighbouring app'));"
                         " return true; })()", timeout=15)

                # Capture the offline probe's source while the network is still up. Wrapped in
                # an async IIFE: top-level await is illegal in a classic script, which is why
                # the main probe load above is wrapped too.
                src = await ev(
                    f"(async () => (await (await fetch('{offline_path.lstrip('/')}?cb=' + Date.now(),"
                    " {cache: 'no-store'})).text()))()", timeout=20)

                # Reload: with the state cleared, this is the worker's FIRST install, and its
                # activate() sees both seeded caches.
                await osend("Page.reload", {"ignoreCache": False})

                # Precondition, not a sleep: wait until the worker is actually installed and
                # controlling the page, or say so. The whole precache is ~950 KB.
                ready = await ev(
                    "Promise.race([navigator.serviceWorker.ready.then(() => 'ready'),"
                    " new Promise((r) => setTimeout(() => r('TIMEOUT'), 15000))])", timeout=20)
                print(f"=== offline phase: service worker {ready} ===")

                # Network emulation is PER-TARGET, and this connection is attached to the page.
                # The service worker is a different target, so it kept reaching the live server —
                # answering the page's requests with real responses, which made the whole offline
                # test measure nothing: the app "booted offline" because the worker proxied to the
                # server, and a shell removed from the precache list still served fine. Stopping
                # the server is the one condition nothing can route around. The worker's own
                # connectivity is asserted in the probe (workerIsOffline), so this can never
                # silently regress into the same trap.
                port = urllib.parse.urlsplit(target["url"]).port
                killer = await asyncio.create_subprocess_exec(
                    "fuser", "-k", "-n", "tcp", str(port),
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                )
                await killer.wait()
                await osend("Network.clearBrowserCache")
                await osend("Network.emulateNetworkConditions", {
                    "offline": True, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1,
                })
                # A marker the offline probe checks: if it survives the reload below, the
                # navigation never committed (Chrome keeps the current document when a reload
                # fails) and the probe would be measuring the ONLINE-loaded page instead.
                await ev("window.__sfPreOffline = true", await_promise=False)
                await osend("Page.reload", {"ignoreCache": True})
                await asyncio.sleep(2.0)

                body = await ev(f"(async () => await eval({json.dumps(src)}))()", timeout=60)
                parsed = json.loads(body) if body else {}
                if body is None:
                    print("=== offline phase: the probe produced NO result ===")
                print("=== offline phase ===")
                for step in parsed.get("steps", []):
                    print_step(step)
                for e in parsed.get("errors", []):
                    print("PHASE ERROR: " + e)
                    failures.append(f"offline phase: {str(e)[:200]}")
                for k, v in parsed.items():
                    if isinstance(v, bool):
                        checks[k] = v
                # This phase's CONTRACT is to report booleans, so an absence is failure — not
                # the "steps without criteria" shape that driver phases (drag/rotate/touch)
                # legitimately have. Without this, a probe that never ran at all contributes
                # nothing and the run still prints a tidy tally: a silent shortfall, which is
                # exactly how a phase goes missing without anyone noticing.
                if not any(isinstance(v, bool) for v in parsed.values()):
                    failures.append("offline phase contributed no criteria — the probe did not run")

                # Nothing may leave the origin. The expected origin comes from the TARGET url,
                # not from the page: before a worker exists the offline reload fails, Chrome
                # shows its own error page, and that page's location.origin is "null" — which
                # makes every real URL look cross-origin. `data:`/`blob:` have no origin to
                # compare, so http(s) only.
                parts = target["url"].split("/")
                expected_origin = "/".join(parts[:3]) if len(parts) >= 3 else target["url"]
                foreign = sorted({u for u in net if u.startswith("http") and not u.startswith(expected_origin)})
                checks["noCrossOriginRequests"] = not foreign
                if foreign:
                    print("=== CROSS-ORIGIN REQUESTS ===")
                    for u in foreign[:10]:
                        print("  " + u)
                print(f"=== offline phase: {len(net)} request(s) seen, expected origin "
                      f"{expected_origin}, all same-origin: {not foreign} ===")
        except Exception as exc:
            failures.append(f"offline phase: {type(exc).__name__}: {exc}")

    print("=== checks ===")
    for k, v in checks.items():
        print(f"  {'PASS' if v else 'FAIL'}  {k}")
    failed = [k for k, v in checks.items() if not v]
    if not checks:
        print("  (probe reported no boolean criteria — fix the probe)")
        return 1
    print(f"=== {len(checks) - len(failed)}/{len(checks)} passed ===")
    # A tally of N/N is not a pass on its own: the run also has to have produced the
    # criteria it was supposed to, and a clean console. Naming these is what stops
    # "no tally line" and a silent shortfall from being the only symptoms.
    if hard:
        print(f"=== FAILED: {len(hard)} console error(s)/exception(s) — see above ===")
    for f in failures:
        print(f"=== FAILED: {f} ===")
    if failed or failures or hard:
        return 1
    return 0


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "tests/e2e/probe.js"
    match = sys.argv[2] if len(sys.argv) > 2 else "8123"
    sys.exit(asyncio.run(main(path, match)))
