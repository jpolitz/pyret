# Resume: code.pyret.org (CPO) integration — FULL `npm run mocha` PARITY on both backends

Branch **`async-transform`**. Committed as one logical commit on top of `b86f38b10` (not pushed; see *Files changed*).
This continues the CPO integration stage planned in `PLAN-cpo-integration.md` (predecessor:
`RESUME-3dfa35c14.md`). The async/promise backend (stages 0–6 + perf + safe-for-space TCO) was already
done; **this session brought code.pyret.org itself to parity on the promise backend.**

## Headline
**The CPO browser app builds and runs on EITHER backend, and the third acceptance leg —
`npm run mocha` (selenium) — is `311 passing / 0 failing / 45 pending`, BYTE-IDENTICAL on cont and
promise.** The 45 pending are skipped on both (Google-OAuth/DB/embed infra not configured here — not a
backend gap; intentionally left skipped). cont is untouched; every change is additive + either CPO-side
or promise-runtime-only. Full write-up in **`REPORT.md` → "code.pyret.org (CPO) integration"**.

## Read first
1. `REPORT.md` § *code.pyret.org (CPO) integration* — the spec for the build plumbing + both fixes.
2. Memory `async-transform.md` (CPO INTEGRATION section) — same, with the diagnostic play-by-play.
3. `PLAN-cpo-integration.md` — the staged plan + live progress.
4. This file.

## What's DONE (don't redo)
- **Stage 0** — `npm run mocha` RUNS HEADLESS here (the "unrunnable on this VM" note was false). Chrome
  148 at `/bin/google-chrome`; a matching chromedriver 148 lives at
  `/tmp/148.0.7778.178/chromedriver/chromedriver-linux64/chromedriver`, wired via `CHROMEDRIVER_BINARY`
  in `code.pyret.org/.env`; selenium 3.6.0 drives it. cont baseline green.
- **Stage 1** — both-backend build plumbing (all additive; cont byte-identical):
  - `code.pyret.org/pyret` → symlink to `../lang`.
  - `cpo-config-async.json` = `cpo-config.json` with `runtime.js → runtime-async.js` (one line).
  - `make web-promise` → `build/web/js/cpo-main-promise.jarr` (`--stack-backend promise`,
    `--compiled-dir ./compiled-promise`, same `build/web`). Backend-keyed caches (`compiled/` vs
    `compiled-promise/`, never mixed). All 119 modules compile clean under async, no source changes.
  - Side-by-side servers (NO `server.js` change): same `build/web`, differ only by `PYRET` + `PORT`.
- **Stage 2 — fix #1 (promise editor wouldn't load): `pauseStack` released RUN_ACTIVE.**
  `lang/src/js/base/runtime-async.js` `pauseStack` (~3980). CPO's REPL runs each interaction via a
  same-runtime nested run (`load-lib.js` `run-program`: `runtime.pauseStack(… runtime.runThunk(…))`).
  On async the outer run stayed `RUN_ACTIVE` while awaiting the pause → nested run rejected ("run called
  while already running"); the raw-value exn (no `.stack`) then crashed exn-stack-parser. **Fix: release
  `RUN_ACTIVE` on pause, restore on resume/error/break** (mirrors cont's unwind). A stack-trace
  difference with SEMANTIC impact, not cosmetic.
- **Stage 2 — fix #2 (check/error-failure rendering `field-not-found`): sync srcloc compare in
  `search`.** `code.pyret.org/src/web/js/output-ui.js` `search` (~513). It used `runtime.equal_always(l,
  loc)` + the srcloc `contains` method as SYNC booleans, but on async **`equal_always` on two flat
  OBJECTS returns a `Promise`** (truthy) → `search` matched the first non-ignorable node (`s-check`
  block) instead of the exact `s-check-test` → `test-ast.left` (`checker.arr:36`) `field-not-found`.
  **Fix: compare flat srclocs synchronously on char offsets** (source + start-char + end-char for
  equality; char-range for contains). Promise check-blocks 11→29/29, errors 54→193/193.
- **Stages 3+4** — full suite at parity (`311/0/45` both backends); **no CPO-trove `.js` needed a
  `stackBackend` branch** for what the suite exercises (charts/world/tables/images all pass).
- **Diagnostic tool**: `code.pyret.org/test-util/console-probe.js` — loads `/editor` headless, optional
  REPL eval, dumps browser console + `#output`. (The jarr is a self-contained gitignored artifact →
  patch it directly to instrument, rebuild with `make web-promise` to restore clean.)

## Validation (all green)
- **Node, no regression from the `pauseStack` change:** `make all-pyret-test-promise` =
  **13008/8/0, byte-identical baseline**; `make async-opt-test` = tco 16 / mutual-tco 48 / flat-sanity 13
  / helper-reentry 7 + 11, all pass. (The "make Error 4" on the suite is just its non-zero exit from the
  8 spec-flagged test-repl stacktrace pins — same as always.)
- **`make new-bootstrap-promise`** (self-host fixpoint, validates the runtime change end-to-end):
  **phaseD == phaseE byte-identical** (both 25,585,909 bytes; `cmp` clean). The `pauseStack` change is
  runtime-only and does not perturb the compiler's self-hosted output — the byte-stable fixpoint holds.
- **CPO both backends:** `npm run mocha` per-file (`/tmp/run-suite.sh <BASE_URL> <LABEL>`): 311/0/45
  identical. cont re-verified after rebuilding its jarr with the shared `output-ui.js` change.

## Build / run / test (from `code.pyret.org/`, one-time `npm install` already done)
```
make web           # cont  → build/web/js/cpo-main.jarr   (+ static assets)
make web-promise   # promise → build/web/js/cpo-main-promise.jarr  (reuses build/web static)

# cont server (:4999):
node -r dotenv/config src/run.js
# promise server (:5999), same build/web, switched by env:
PORT=5999 BASE_URL=http://localhost:5999 \
  PYRET=http://localhost:5999/js/cpo-main-promise.jarr node -r dotenv/config src/run.js

# run a test against either backend:
set -a; . ./.env; set +a
BASE_URL=http://localhost:5999 npx mocha test/check-blocks.js --timeout 120000
# whole suite per-file on a backend:
bash /tmp/run-suite.sh http://localhost:5999 PROMISE
```
After editing the promise runtime: `cp lang/src/js/base/runtime-async.js lang/build/phaseA/js/` then
force-rebuild (`rm -f build/web/js/cpo-main-promise.jarr && make web-promise`). After editing a CPO
`src/web/js/*.js`: just `make web-promise` (and `make web` for cont) — the rule depends on `src/web/js/*.js`.

## Files changed (one commit on `async-transform`, on top of `b86f38b10`)
- `lang/src/js/base/runtime-async.js` — `pauseStack` RUN_ACTIVE release/restore (fix #1).
- `code.pyret.org/src/web/js/output-ui.js` — `search` sync srcloc compare (fix #2).
- `code.pyret.org/Makefile` — `web-promise` target (+ `clean` wipes `compiled-promise/`).
- `code.pyret.org/cpo-config-async.json` — NEW (async require-config).
- `code.pyret.org/test-util/console-probe.js` — NEW (diagnostic tool).
- `REPORT.md`, `PLAN-cpo-integration.md`, memory `async-transform.md` — docs.
- `code.pyret.org/.gitignore` — added `compiled-promise/` (the backend-keyed cache).
- (gitignored build artifacts: `code.pyret.org/{pyret symlink, node_modules, build/, compiled-promise/}`.)
- Committed as one commit on `async-transform`; **not pushed** (push is the owner's call).

## Next
- **Push** when ready (committed locally on `async-transform`, not pushed).
- **Audit the `equal_always`-as-sync-bool-on-objects pattern** if future failures appear: any CPO JS
  using `runtime.equal_always` — or a non-flat Pyret method via `.app` — as a synchronous boolean on
  OBJECTS has the same latent bug on promise. The mocha-exercised paths are clean; this is a
  forward-looking caution.
- **Stage 5 (ergonomics, deferred):** turn the manual two-server / `/tmp/run-suite.sh` flow into make
  targets / a `both` runner that diffs failing-sets; a documented leak-hook toggle.
- The 45 infra-gated skips (Google/DB/embed) are intentionally left skipped — annoying to set up and
  identical on both backends.
