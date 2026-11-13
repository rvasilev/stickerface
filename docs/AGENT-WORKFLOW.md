# Working on this repo as an AI agent

This file documents the workflow that built StickerFace, so the next agent (or
the next session) does not rediscover it. It is deliberately concrete.

## The loop that works

1. **Read before writing.** `PLAN.md` → `docs/ARCHITECTURE.md` →
   `docs/VERIFICATION.md` → this file. The spec lives in the repo, not in chat.
2. **Do the deterministic work yourself**, before delegating: anything
   network-dependent, licence-sensitive or that must be reproducible (vendored
   assets via a committed generator script, attribution files, `package.json`,
   fixture generation). The coding agent then only writes app logic.
3. **Delegate implementation** to a coding agent (see the packet template below).
4. **Verify externally.** The agent's summary is a self-report. Run the gates
   yourself: `npm test`, then `npm run e2e`. Then check the deployed artifact.
5. **Push only after both gates are green**, then confirm the Pages build and run
   the probe against the live URL.

## Delegation packet template

A packet is a text file passed to the coding agent. It works when it contains:

- **Task sentence** — what to build/fix, in one line.
- **Pointers** — "read PLAN.md and AGENTS.md first; they are the spec".
- **Evidence** — for a fix: the exact failing output, the reproduction command,
  the suspected cause. Never "make it work"; always "here is the reproduction".
- **Numbered deliverables** — one per file or behaviour.
- **Non-negotiables** — the invariants from AGENTS.md, repeated inline (the agent
  may not read them).
- **The gate** — the exact commands it must run and paste, and the exact pass
  condition (`N/M passed`, `E2E_EXIT=0`). Name the probe if it is not the main one:
  `E2E_PROBE=tests/e2e/<probe>.js npm run e2e`.
- **Honesty clause** — "if you cannot start headless Chrome, say so; do not claim
  a passing probe you did not run".

Keep the packet in `/tmp` (it is scratch, not a repo artifact) and keep the
transcript next to it.

## Running a long coding-agent session

A multi-minute agent run must not be a Hermes background process: those live in a
~5 GB cgroup that SIGKILLs a long node agent mid-run, and a foreground wait past
600 s is promoted into the same cgroup. Detach it under systemd and capture
everything to files:

```bash
# /tmp/run-x.sh
exec > /tmp/x.out 2>&1
cd /home/roman/Documents/Projects/stickerface || exit 2
export NODE_ENV=development                 # or npm silently skips devDependencies
export OC_TRANSCRIPT=/tmp/x.jsonl OC_TIMEOUT=2400
timeout 2700 ~/.hermes/bin/oc --dir "$PWD" "$(cat /tmp/packet.txt)"
echo "OC_EXIT=$?"
python3 ~/.hermes/scripts/oc_verify.py /tmp/x.jsonl --dir "$PWD"
echo "VERIFY_EXIT=$?"

systemd-run --user --unit=stickerface-x --collect /bin/bash /tmp/run-x.sh
```

Never `tail` the NDJSON transcript — it embeds whole file contents per event and
will blow the capture window. Extract aggregates instead:

```bash
grep -ao '"tool":"[a-z]*"' /tmp/x.jsonl | sort | uniq -c   # what it actually did
grep -aE "^(OC_EXIT|VERIFY_EXIT)=" /tmp/x.out             # outcomes
```

## Verification discipline (learned the hard way here)

- **A green unit suite is not the app working.** The first build passed 48/48 unit
  tests while export was permanently disabled and the picker was built twice. Only
  the browser probe caught it. Run `npm run e2e`.
- **`oc_verify.py` can false-fail.** If the packet tells the agent to commit, a
  successful run ends with a clean working tree and the verifier prints
  `FAIL: agent claimed edits but the working tree is unchanged` → `VERIFY_EXIT=1`.
  Re-check with `git log --oneline` instead of doubting the run.
- **Check element counts, not just behaviour.** The duplicate `CanvasApp` doubled
  every listener while the layer count still looked correct, because each instance
  re-rendered the list from its own store.
- **Prove pixels.** An export test that only asserts "a Blob exists" would have
  passed a build that drew nothing. The probe compares a pixel inside the sticker
  bbox (must differ) and one outside it (must be identical ±2).
- **Verify the deployed artifact, not just the working tree.** Run the probe
  against `https://rvasilev.github.io/stickerface/` with a second Chrome
  (`CDP_HTTP=... run.py probe.js github.io`). A Pages build can be stale or fail
  silently.
- **Never `git add -A` while a delegated agent is writing to the tree.** Two of this
  repo's commits were labelled as doc/test changes but contained the agent's
  in-flight app code, because `git add -A` swept the working tree. Stage explicit
  paths once an agent is running; if you already committed, rewrite the boundaries
  (`git reset --mixed <base>` then re-stage per change) before pushing.
- **Attribute a local failure before fixing it.** A tree an agent is mid-edit on
  produces failures that belong to *its* unfinished work — running the gates there
  and blaming your own change is the classic false attribution. Rebuild a clean tree
  at HEAD (`git archive HEAD | tar -x -C /tmp/sf-head`), copy in only the files you
  changed, and run the gates there.
- **A gate must fail when it verified nothing.** `run.py` returns 1 when a probe
  emits no criteria at all; keep it that way. The same trap in a criterion reads as
  PASS for "nothing happened" — guard every criterion on the action having occurred
  (three zoom criteria passed vacuously until they were guarded on the zoom
  actually happening).

## What to do with what you learn

- A defect class → add it to the **Pitfalls** section of `AGENTS.md`.
- A new acceptance criterion → add a boolean to `tests/e2e/probe.js`.
- A new module or invariant → update `docs/ARCHITECTURE.md`.
- A dependency decision → record it in `docs/DEPS.md` with licence, size and the
  reason, including rejections.
- A change to what the product does → `PLAN.md` and `README.md` "Features", and
  the Obsidian note (`Projects/StickerFace/README.md`) which is the index.

## Environment facts for this machine

- `NODE_ENV=production` is exported globally → always
  `NODE_ENV=development npm install --include=dev`.
- No Playwright/Puppeteer installed, and the Hermes CDP tool refuses loopback page
  URLs → the E2E harness is a hand-rolled CDP client (`websockets` + headless
  Chrome started with the URL as an argument).
- `google-chrome-stable` is at `/usr/sbin/google-chrome-stable` (Chromium 157).
- `file://` will not load ES modules — always serve over HTTP.
