# Resume: async/promise backend done — NEXT STAGE is code.pyret.org integration

Branch **`async-transform`**. Resume-point commit **`3dfa35c14`**. The whole
async/promise backend is done: the backend (stages 0–6), the perf push, and
**safe-for-space tail calls for both functions AND methods**. **Next goal: build
out the stages to make this new backend usable in code.pyret.org (CPO)** — the
intended design endgame. The first task is to PLAN those stages (as with the
original 7-stage backend plan); don't dive into CPO code before there's a staged
plan. See "## Next stage: CPO integration" below.

## Read first
1. Project memory `async-transform.md` — full history. The two safe-for-space
   entries (functions, then "METHODS NOW SAFE-FOR-SPACE TOO") have the design,
   the closure-not-`this` lesson, and the guard-test breakdown.
2. **`REPORT.md`** § "Safe-for-space tail calls" — the spec for the mechanism.
3. This file.

## What's DONE (don't redo)
Cross-function / higher-order / first-class / cross-module / **method** tail
calls are all O(1) heap on the promise backend.
- A non-self tail call to a non-flat callee in tail position mints a token:
  `R.tailCall(f, [args])` (function) or `R.maybeMethodTail(obj, name, loc, …)`
  (method-app → `TailMethodCall`/`TailCall`). The public `.app` / `full_meth`
  DRIVE; the internal `appBody` / `full_methBody` mint. One shared `drive()` loop
  pumps both token kinds, so mixed function⇄method chains stay flat.
- Selective: only token-producing closures/methods get the driving wrapper
  (`makeTailFunction`/`makeTailMethod`), recorded per-body in a `token-cell`;
  everything else keeps `app === appBody` / `full_meth === full_methBody`, zero
  overhead. Self tail calls keep the `while(true){continue}` loop.
- Drivers CLOSE OVER the body (never read `this`) — `cases` `$app_fields` and
  trove FFI (`make-reactor`, `place-image`) extract `.app`/`full_meth` bare.
- Verified: `bench-mutual` + method `ev`⇄`od` + cross-module + cases-branch all
  flat ~150 MB at 1M–20M; mutual-tco-test 48 checks (portable); suite 13008/8
  (test-repl frame-shape pins only); bootstrap D==E byte-identical; benches
  within noise, outputs byte-equal.
- Anchors: `runtime-async.js` (PFunction/PMethod, TailCall/TailMethodCall,
  drive, makeTail*, maybeMethodTail); `anf-loop-compiler-async.arr`
  (compile-app-async, compile-method-app-async, compile-a-lam, compile-a-method,
  compile-fun-body's `can-mint-tokens`/`mints-tokens`/`token-cell`).

## Next stage: code.pyret.org (CPO) integration
Goal: make CPO work on the promise/async backend — the intended design endgame.
Untouched so far: all work is the `lang/` backend + the Node standalone/bootstrap
path. **First action: write a staged plan with its validation gates** (mirror the
original 7-stage backend plan); scope it out before editing anything in
`code.pyret.org/`.

Two pieces of guidance that should shape every edit:
- **(a) Compatible with EITHER backend — not a switch.** CPO is NOT migrating to
  promises; it must build and run on **both** cont and promise, selectably, with
  both versions easy to build/run/test side by side. Every change keeps cont
  working and adds the promise path alongside it (flag/variant), never replacing
  it. Make testing-both the easy default.
- **(b) Watch raw `.app()` usage.** CPO's JS calls `.app()` fairly liberally and
  leans on it returning a value *synchronously* — which holds on cont always, but
  on promise only for FLAT callees (a non-flat `.app()` returns a Promise; for a
  token-producing fn it's the driver). So promise breakage will tend to surface
  as the familiar **"Non Pyret value: Promise"** leak where a value was expected.
  It "works out" on cont; the implicit flatness-or-related assumption at those
  `.app` sites is the likely gotcha on promise — audit them.

(Deferred, not this stage: the lazy stack-trace ring buffer — recorded in memory
`async-transform.md` if trace fidelity ever matters.)

## Validation gates (run ALL after any change)
Same as before — see memory `async-transform.md`.
1. `make phaseA`; after runtime .js: `cp src/js/base/runtime-async.js
   build/phaseA/js/` + `rm -rf compiled-promise tests/compiled-promise
   build/phase?-promise`.
2. O(1) heap probes: `bench-mutual` and a method `ev`⇄`od` at 1M/5M/20M, maxRSS
   flat (`/usr/bin/time -f "%M KB" node …p.jarr`).
3. `make async-opt-test` — mutual-tco-test (48), helper-reentry 11, etc.
4. `make all-pyret-test-promise` — parity (only test-repl check-block-6
   frame-shape pins; a token leak shows up as "Non Pyret value:" / contract
   errors / new fails).
5. `make new-bootstrap-promise` — D==E byte-identical.
6. Re-bench `tests/async-opt/bench-*` cont vs promise — no regression; outputs
   byte-equal.

## Single-file build/run (from `lang/`)
- promise: `node build/phaseA/pyret.jarr --outfile T.p.jarr --build-runnable
  tests/async-opt/T.arr --builtin-js-dir src/js/trove/ --builtin-arr-dir
  src/arr/trove/ --compiled-dir compiled-promise/ --stack-backend promise
  -check-all --require-config src/scripts/standalone-configA-async.json && node
  T.p.jarr`
- bench mem: `make tests/async-opt/T.p.jarr EF=' '` then `/usr/bin/time -f
  "%e s, %M KB" node tests/async-opt/T.p.jarr`.
- Inspect emitted JS: grep `makeTailFunction` / `makeTailMethod` / `R.tailCall` /
  `maybeMethodTail` in the built `.p.jarr`.
