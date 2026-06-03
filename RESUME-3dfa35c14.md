# Resume: async/promise backend — safe-for-space complete; lazy-trace idea next

Branch **`async-transform`**. Resume-point commit **`3dfa35c14`**. The whole
async/promise backend is done: the backend (stages 0–6), the perf push, and
**safe-for-space tail calls for both functions AND methods**. There is no
required next feature — this file records the state and the one open *optional*
idea (a lazy stack-trace window). Pick it up only if trace fidelity matters.

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

## The one open idea: a lazy stack-trace window (OPTIONAL)
Our scheme is **eager** frame collection (the `appBody`/`full_methBody` frame
dies at the tail call); cont is **lazy** (ActivationRecords linger, read on
demand). That is why our traces collapse harder — the spec-flagged test-repl
`check-block-6` pins grew 5 → 7 → 8 as functions then methods began collapsing
caller frames. The value-flow MUST stay eagerly bounced (the O(n) proof forbids
lazy retention of the result dependency), but the **trace is a separable object**:

- Make the token carry its `apploc` (compile-app-async / maybeMethodTail already
  have `compiler.get-loc(l)` at hand). In `drive()`, keep the last K
  `(name, apploc)` in a cyclic buffer (O(K) = O(1) memory, overwrite oldest).
- On a raise, surface that buffer as a K-deep recent-frames trace. Recovers
  cont's shallow-depth fidelity (most test-repl pins would close) with a correct
  *truncated suffix* at depth. Gate behind a debug flag so the hot path (the
  common no-error bounce) pays nothing — only stamp the ring when the flag is on.
- DEAD END (don't): "let the await chain accumulate K frames then collapse in
  batches." Each `.app`/`full_meth` is itself a driver, so it re-nests = O(n);
  routing through `appBody` directly still costs one microtask per `await` on
  descent and unwinds K awaits per batch — no time win, more peak memory. Retain
  trace *metadata*, not live frames.

If you build it: add the apploc to `TailCall`/`TailMethodCall`, thread a debug
flag through the runtime, and wire `get-result-stacktrace` to read the ring when
the synchronous JS stack is shorter than the ring. Then re-run the test-repl
`check-block-6` pins — some should flip green; document which legitimately can't
(true deep-recursion suffixes).

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
