# Plan: code.pyret.org (CPO) integration — promise backend, side-by-side with cont

Branch `async-transform`. Resume-point `3dfa35c14` (async backend done: stages 0–6 +
perf + safe-for-space TCO for functions AND methods). This is the **CPO integration
stage** — the design endgame from the spec. Predecessor planning docs:
`RESUME-3dfa35c14.md`, `REPORT.md`, memory `async-transform.md`.

## PROGRESS (live)
- **Stage 0 DONE** — mocha runs headless here (Chrome 148 + matching chromedriver via
  `CHROMEDRIVER_BINARY` in `.env`; selenium 3.6.0 drives it). cont baseline green:
  basic / number / check-blocks 29 / errors 193.
- **Stage 1 DONE** — `pyret`→`../lang` symlink; `cpo-config-async.json`; additive `make
  web-promise` → `build/web/js/cpo-main-promise.jarr` (cont jarr untouched; caches
  backend-keyed; all 119 modules compile clean under async). Side-by-side = two servers, same
  `build/web`, differ only by PYRET env + PORT (cont :4999, promise :5999) — no server.js change.
- **Stage 2 PARTLY DONE — the big bug fixed.** Root cause of promise editor not loading: async
  `pauseStack` kept a *paused* run `RUN_ACTIVE`, so CPO's same-runtime nested-run REPL idiom
  (`load-lib.js` run-program: `runtime.pauseStack(... runtime.runThunk(...))`) hit "run called
  while already running"; that failure's raw-value exn (no JS `.stack`) then crashed
  exn-stack-parser → the missing-`.stack` was a *semantic-impact* stack divergence, not cosmetic.
  **Fix (`lang/src/js/base/runtime-async.js` `pauseStack`): release RUN_ACTIVE on pause, restore
  on resume** (mirrors cont's trampoline unwind). VALIDATED: `all-pyret-test-promise` 13008/8/0,
  byte-identical baseline (no node regression); CPO REPL works — number.js passes, `1+1`→`2`,
  `raise` renders. (async-opt-test running; new-bootstrap-promise still TODO — pauseStack doesn't
  touch codegen.)
- **Stage 2 DONE — second bug also fixed.** The error/check-FAILURE `field-not-found` was CPO's
  loc→AST `search` (`output-ui.js`) using `runtime.equal_always(l, loc)` as a SYNC boolean — but
  on the async backend `equal_always` on two flat *objects* returns a **Promise** (truthy), so
  `search` matched the first non-ignorable node (the `s-check` block) instead of the exact
  `s-check-test`, hitting `test-ast.left` (checker.arr:36). **Fix: compare flat srclocs
  SYNCHRONOUSLY on char offsets in `search`** (the code already asserts "srclocs are flat data").
  **RESULT: promise check-blocks 29/29 + errors 193/193 (was 11/29, 54/193) — full parity; cont
  re-verified 29/29 + 193/193, no regression from the shared output-ui.js change.** Diagnostic
  tool: `code.pyret.org/test-util/console-probe.js`. WATCH: other JS sites using `equal_always`
  (or a non-flat method `.app`) as a sync boolean on objects share this latent bug — audit as
  Stage 4 exercises more paths.
- **NEXT:** Stage 4 — run the FULL `npm run mocha` suite on both backends (more files: tables,
  world, charts, image-equality, modules, type-check…; some need Google/DB) to map remaining
  divergences; Stage 3 CPO-trove `.js` async-awareness as those tests demand; then Stage 5/6.

## The two owner constraints (shape every edit)
- **(a) EITHER backend, not a switch.** CPO is NOT migrating to promises. It must build
  and run on **both** cont and promise, selectably, side by side, both easy to
  build/run/test. Every change keeps cont working and adds the promise path *alongside*
  (flag/variant/separate dir), never replacing it. **Make testing-both the easy default.**
- **(b) Watch raw `.app()`.** CPO's JS calls `.app()` liberally and assumes a value comes
  back *synchronously* — true on cont always; on promise only for FLAT callees (a non-flat
  `.app()` returns a Promise / the driver). Breakage surfaces as the familiar
  **"Non Pyret value: Promise"** leak. The implicit flatness assumption at those `.app`
  sites is the gotcha — audit and make them backend-aware (branch on `runtime.stackBackend`,
  await where needed), the same pattern used for the `lang/` trove `.js` files.

## Acceptance leg (the spec's unfinished third gate)
`npm run mocha` — CPO selenium browser integration tests in `code.pyret.org/`. Never
exercised here on either backend. **Verify it EARLY (Stage 0) on cont**, then drive it
green on both. (The old "unrunnable on headless VM" note was an *unverified assumption* —
headless Chrome IS here; see Facts. Don't inherit the claim.)

## Facts established by recon (don't re-discover)
- **CPO is unbuilt here.** No `pyret` symlink, no `node_modules`, no `build/`. From-scratch
  plumbing. `code.pyret.org/.gitignore` ignores build artifacts.
- **CPO build = the same `pyret.jarr --build-runnable` path used in `lang/`.** Makefile
  `$(CPOMAIN)` rule runs `node pyret/build/phaseA/pyret.jarr --builtin-js-dir src/web/js/trove/
  --builtin-js-dir pyret/src/js/trove/ -allow-builtin-overrides --builtin-arr-dir
  src/web/arr/trove/ --builtin-arr-dir pyret/src/arr/trove/ --require-config cpo-config.json
  --build-runnable src/web/arr/cpo-main.arr --standalone-file cpo-standalone.js --compiled-dir
  ./compiled --deps-file $(BUNDLED_DEPS) --outfile build/web/js/cpo-main.jarr -no-check-mode`.
  **No `--stack-backend` flag today → defaults to cont.**
- **`pyret` is a symlink to pyret-lang root.** `PYRET=$(call NODE_MODULE,pyret-lang)/../..`;
  `link-pyret`/`install-link` do `ln -s $(PYRET) pyret` / `npm link pyret-lang`. Our
  pyret-lang root is the sibling **`../lang`** (`lang/package.json` name = `pyret-lang`).
  So `pyret/build/phaseA/pyret.jarr` must resolve to `lang/build/phaseA/pyret.jarr`.
- **`lang/build/phaseA` is already built** — `pyret.jarr` (30 MB) AND
  `build/phaseA/js/runtime-async.js` both present (Jun 3). The cont compiler + the async
  runtime are ready to link. No `lang/` change is needed for CPO's promise build — it just
  passes `--stack-backend promise` + an async require-config (runtime-async.js is already in
  `build/phaseA/js/`).
- **`cpo-config.json`** is CPO's require-config (analog of `standalone-configA.json`). Its
  `raw-js` maps `pyret-base/js/runtime.js → pyret/build/phaseA/js/runtime.js`. The promise
  variant needs a `cpo-config-async.json` mapping that one line to `…/runtime-async.js`
  (mirrors `standalone-configA-async.json`).
- **`cpo-standalone.js`** is CPO's browser standalone template (analog of `handalone.js`).
  It drives via `runtime.runThunk(... runtime.runStandalone(...) ...)` and its `.app()` /
  `full_meth()` calls are mostly wrapped in `runThunk` / `safeCall` (which the async runtime
  already handles thenable-aware) — so it's *likely* mostly OK, but verify (Stage 2).
- **`postinstall` = `webpack && make -j3 web`.** So `npm install` itself triggers the CPO
  build, which needs the `pyret` symlink + phaseA present FIRST. Install order matters
  (symlink → install, or `npm install --ignore-scripts` → symlink → `make web`).
- **Server (`src/run.js` → `src/server.js`) boots without external infra.** Redis is
  optional (`REDISCLOUD_URL=""` → `client=null`); storage ops only fail if save/load/share is
  actually invoked, not when serving `/editor`. Google creds can be empty. **No postgres
  needed** for the editor/REPL path (the `.env.test.example` postgres lines are unused by
  `run.js`, which uses redis). Serves the built jarr at `PYRET=http://localhost:PORT/js/cpo-main.jarr`.
- **Mocha harness** (`test-util/util.js`): builds a **headless Chrome** webdriver
  (`--headless --no-sandbox`), and tests assume a CPO server is **already running** at
  `BASE_URL` — they just `browser.get(base + "/editor")`, wait for `#loader` to hide, eval at
  the REPL, assert on DOM. So the mocha leg needs: chromedriver+chrome + a running CPO server.
  `npm run mocha` = `heroku local:run mocha` (loads `.env`, runs `mocha` over `test/*.js`).
  Representative tests: `test/basic.js` (loads `/editor`), `test/number.js` (REPL `1/7`),
  `test/errors.js`, `test/check-blocks.js`, `test/pyret.js` (image programs).
- **`.app()` audit surface = 11 CPO JS files.** Run-path-critical: `cpo-main.js` (14),
  `output-ui.js` (11), `ide.js` (8), `check-ui.js` (4), `error-ui.js` (4), `repl-ui.js` (1),
  `trove/world.js` (6). I/O-only (deprioritize): `gdrive-locators.js` (24), `file-locator.js`
  (8), `trove/gdrive-sheets.js` (7). (Detailed run-path audit in progress.)

## Environment risks (confirm/clear early — Stage 0)
- **chromedriver / selenium version skew (HIGH).** System has **Google Chrome 148**, **no
  system chromedriver**. CPO devDeps pin `chromedriver ^146` and `selenium-webdriver 3.6.0`
  (2017, JsonWire/OSS dialect). Chrome 148 + chromedriver 146 may mismatch; old selenium may
  not speak W3C-only modern chromedriver. Mitigations to try in order: install a
  Chrome-148-matching chromedriver and point `CHROMEDRIVER_BINARY` at it (util.js honors that
  env); if selenium 3.6.0 can't drive it, consider a contained bump of `selenium-webdriver`
  (devDep only — does NOT touch the cont/promise runtime or app code, so it's compatible with
  constraint (a)). This is the single most likely thing to block the whole leg — clear it FIRST.
- **`npm install` on the exe.dev proxy (MEDIUM).** Large dep tree incl. a chromedriver binary
  download. May be slow or need the proxy. Use `--ignore-scripts` first (so install doesn't
  fail in `make web` before the pyret symlink exists), then build manually.
- **No postgres/redis (LOW).** Confirmed optional for the editor/REPL path; only matters if
  a test exercises save/share. Note which mocha tests (if any) need it and skip/flag them.

---

## Stages (mirror the original 7-stage backend plan; run the gate after each)

### Stage 0 — Baseline: prove the mocha harness runs on the EXISTING cont backend
No backend work. De-risk the whole effort: if mocha can't run on this VM, find out now.
1. `pyret` symlink → `../lang` (so `pyret/build/phaseA/pyret.jarr` resolves).
2. `cd code.pyret.org && npm install --ignore-scripts` (avoid the postinstall build firing
   before we're ready); then `make web-local` (or `make web`) to build cont `cpo-main.jarr`
   + static editor into `build/web/`.
3. `.env` from `.env.example`: `BASE_URL=http://localhost:4999`, `PORT=4999`,
   `PYRET=http://localhost:4999/js/cpo-main.jarr`, empty Google, `REDISCLOUD_URL=""`.
4. Boot `node src/run.js`; confirm `GET /editor` serves and Pyret loads ("REPL ready" /
   `#loader` hidden) by hand (curl/headless) before involving mocha.
5. Resolve chromedriver (see risk above); run **one** spec first:
   `BASE_URL=… npx mocha test/basic.js` → green, then `test/number.js`.
6. Then the fuller `npm run mocha`; record the cont baseline failing-set.
- **GATE 0:** `test/basic.js` (editor loads) + `test/number.js` (REPL eval) **green on cont**,
  headless, against a locally-served cont `cpo-main.jarr`. Record the full-suite cont baseline.

### Stage 1 — Both-backend build plumbing (the side-by-side infra; the core deliverable)
Add the promise build *variant*, backend-keyed, never touching the cont path. Mirror `lang/`'s
backend-keyed caches (the #1 hazard: never mix cont- and promise-compiled modules).
1. `cpo-config-async.json` = copy of `cpo-config.json` with the single line
   `pyret-base/js/runtime.js → pyret/build/phaseA/js/runtime-async.js`.
2. Makefile: additive promise target(s) — build `cpo-main.arr` with `--stack-backend promise`,
   `--require-config cpo-config-async.json`, `--compiled-dir ./compiled-promise`, into a
   SEPARATE output (e.g. `build/web-promise/js/cpo-main.jarr`). Keep `compiled/` (cont) and
   `compiled-promise/` strictly separate. No existing target edited.
3. Server: make the served web-root / `PYRET` jarr selectable (env var, e.g.
   `CPO_BUILD_DIR` / `CPO_BACKEND`) so a cont server and a promise server can run side by side
   on two ports — "testing-both" becomes: boot two servers, run mocha twice. Minimal,
   additive `server.js` change (default = today's path = cont).
- **GATE 1:** both cont (`build/web/js/cpo-main.jarr`) and promise
  (`build/web-promise/js/cpo-main.jarr`) **build clean**; cont jarr byte-identical to Stage 0
  (no cont regression); caches don't cross.

### Stage 2 — Promise standalone bring-up (first .app() leaks surface here)
Boot a server on the promise build; load `/editor`; drive it to "REPL ready" + a trivial eval.
Fix the constraint-(b) sites the audit flags in the *standalone + run path* (`cpo-standalone.js`,
`cpo-main.js`, `repl-ui.js`, `output-ui.js`, `check-ui.js`, `error-ui.js`) — backend-aware
(branch `runtime.stackBackend === "promise"`, await), never breaking cont. Use the leak hook
(REPORT "Build/debug notes": `_checkAnn` Promise logger) adapted to the browser/server console.
- **GATE 2:** promise `/editor` loads → "REPL ready"; `1 + 1`, a string, and a simple
  `check:`-block eval render correctly on promise; cont still green (re-run GATE 0).

### Stage 3 — CPO trove `.js` async-awareness
CPO ships its own trove (`src/web/js/trove/*.js`: world/reactor, image, charts, sheets) that
call user code via `.app`/`full_meth`. For the ones exercised by the test programs, mirror the
`lang/` pattern (branch on `runtime.stackBackend`, provide an `await` path; keep cont as-is).
Driven by what `test-util/pyret-programs/{images,world,charts,check-blocks}` actually hit.
- **GATE 3:** the image/world/chart/check-block test programs run on promise; cont unaffected.

### Stage 4 — Full `npm run mocha` parity on BOTH backends
Run the whole suite on cont and promise; triage. Expect the same spec-flagged stack-trace-shape
divergences seen in `lang/` (async frames collapse tail calls; flag, don't fix). Distinguish
genuine promise leaks (fix) from parity failures (cont also fails) and trace pins (flag).
- **GATE 4:** mocha failing-set on promise ⊆ {cont's failing-set} ∪ {spec-flagged trace pins};
  every program-correctness / REPL / error-detection test green on both.

### Stage 5 — Diagnostics & developer ergonomics (the "good diagnostics" deliverable)
Make both-backend test/run a one-liner. Documented make targets / scripts to: build either
backend, boot either server, run mocha against either (and ideally a `both` that does cont then
promise and diffs failing-sets). Port the leak-debug hook as a toggle. This is what "set up for
good testing + diagnostics" means — leave the next person a turnkey both-backend workflow.
- **GATE 5:** a single documented command builds+serves+mocha-checks each backend; a `both`
  path reports the two failing-sets side by side.

### Stage 6 — Report
Update `REPORT.md` with a "CPO integration" section (build plumbing, the `.app()` audit +
fixes, mocha results on both backends, divergences). New `RESUME-<hash>.md`. Update memory
`async-transform.md`.
- **GATE 6:** REPORT current; gates 0–5 reproducible from the doc alone.

## Lang-side validation gates still apply (re-run if any `lang/` file is touched)
Per memory `async-transform.md` / `RESUME-3dfa35c14.md`: `make phaseA` (+ copy runtime-async.js,
wipe promise caches), O(1) heap probes, `make async-opt-test`, `make all-pyret-test-promise`,
`make new-bootstrap-promise`, re-bench. **This stage should be CPO-only** — if a fix turns out
to need a `lang/` runtime/compiler change, treat it as a lang change and run the full lang gate
set + keep cont byte-identical.

## Sequencing note
Stages 0–1 are the immediate "build plumbing for testing + diagnostics" focus. Stage 0 (mocha
on cont) must pass before any promise work — it proves the harness and isolates env risk from
backend risk. Diagnostics (Stage 5) is a first-class goal threaded throughout, not an
afterthought: every stage should leave the both-backend workflow a little more turnkey.
