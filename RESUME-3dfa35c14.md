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
Goal: make the promise/async backend selectable and working in CPO, the way it
already is for the Node standalone path in `lang/`. **NOT touched yet** — every
change so far is in `lang/` (compiler + runtime) + the Node standalone/bootstrap
path; CPO has zero awareness of the backend (grep for `stack-backend` /
`runtime-async` / `promise` in `code.pyret.org/` is empty).

**First action: write a staged plan** (mirror the original backend's stage list).
Don't start editing CPO until the stages and validation gates are written down.

Known integration surface (already located — starting anchors, NOT a plan):
- `code.pyret.org/cpo-standalone.js` hardcodes
  `requirejs(["pyret-base/js/runtime", …])` → that's `runtime.js` (cont). A
  promise build needs it to load `runtime-async.js` (parameterize or a variant).
- `code.pyret.org/Makefile` `$(CPOMAIN)` rule (~line 394) builds the web bundle
  with `--require-config cpo-config.json --standalone-file cpo-standalone.js`
  against `$(PHASEA)` and **no `--stack-backend` flag** → needs a promise build
  target passing `--stack-backend promise`.
- `cpo-config.json` is CPO's analogue of `standalone-configA.json`; needs a
  promise variant mapping `pyret-base/js/runtime.js` → `runtime-async.js` (mirror
  `lang/src/scripts/standalone-configA-async.json`).
- Backend-keyed promise cache dirs for the CPO build (same lesson as
  `compiled-promise/` — never mix cont/promise compiled JS).
- In short: replicate, for the CPO bundle, what `standalone-configA-async.json` +
  the Makefile `%.p.jarr` rule do for the `lang/` standalone path.

Validation reality check: the **browser path can't be validated headless on this
VM** (mocha/selenium are unrunnable here, per the spec) — CPO-on-promise needs
the real code.pyret.org dev/test harness to confirm in a browser. The runtime's
macrotask yield already uses `util.suspend` (= `postMessage` in the browser), so
that piece should port; the unknowns are the build wiring, the require/AMD load
of the async runtime, and any CPO-side assumptions about the cont runtime's API.

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
