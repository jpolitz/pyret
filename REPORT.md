# Async / Promise Compiler Backend — Report

Branch: `async-transform`. Spec: `async-transform.md`. Design sketch: `async-email-demo.md`.

## What was built

A **second Pyret compiler backend** that compiles every Pyret function to a JavaScript
`async function`, where each call site is `await f.app(...)` and fuel is taken with
`await checkPause()`. It is selected by a flag (`--stack-backend promise`) and links an
async runtime (`runtime-async.js`); the existing Cont/trampoline backend is left
**completely unchanged** and still byte-for-byte reproduces itself.

The motivation (per the spec, à la Stopify): turn JS stack space into heap space so deep
Pyret recursion never overflows, while keeping pause/resume and user-interruptibility — but
expressed natively with `async`/`await` instead of the hand-written trampoline. It is also
**safe-for-space**: cross-function (mutual / higher-order / cross-module) tail recursion runs in
O(1) heap, via a bounce token + driver (see *Safe-for-space tail calls*).

The backend is exercised end-to-end:

- **Full test suite at parity.** `make all-pyret-test-promise` builds the aggregate suite
  (`tests/pyret/main2.arr`, ~80 test files + all builtins) with the promise backend and runs
  it: **Passed 13008, Failed 8, Errored 0 / 13016.** The 8 failures are all spec-sanctioned
  stack-trace-shape divergences (see *Known divergences*); every other file matches Cont.
- **Self-hosts to a byte-stable fixpoint.** `make new-bootstrap-promise` compiles the whole
  compiler with the promise backend and shows it reproduces itself exactly (`phaseD == phaseE`).
- **Safe-for-space mutual tail recursion.** `tests/async-opt/bench-mutual.arr` (`is-even`⇄
  `is-odd`) runs in flat ~133 MB at 1M–20M deep (matching cont), where it previously OOM'd at 5M.
- **code.pyret.org at full parity.** The CPO browser app builds and runs on the promise backend
  alongside cont, and the third acceptance leg — `npm run mocha` (selenium) — is **311 passing /
  0 failing / 45 pending, byte-identical on cont and promise**. See *code.pyret.org (CPO)
  integration* below.

## How to use it

```
# one file (fast):
make foo.p.jarr EF=' '        # builds foo.arr on the promise backend; node foo.p.jarr to run

# full suite on the promise backend:
make all-pyret-test-promise EF=' '

# compiler self-host + fixpoint check on the promise backend:
make new-bootstrap-promise
```

The flag itself: `--stack-backend [promise|cont|auto]` on `pyret.jarr`'s `run` /
`--build-runnable` / `--build` modes. `cont`/`auto` use the existing backend; `promise`
selects async codegen and (at runtime, inside the standalone) the promise cache dirs.

## Architecture

### 1. The flag and the backend bridge

- `--stack-backend` is parsed in `pyret.arr` and carried on the compile options as a
  `StackBackend` value (`compile-structs.arr`).
- The **linked runtime module advertises which backend it is**: `runtime.js` exports
  `STACK_BACKEND: 'cont'`, `runtime-async.js` exports `STACK_BACKEND: 'promise'` (and the
  runtime object carries `stackBackend: 'promise'`). This is surfaced through the
  `runtime-lib` trove as `compiled-stack-backend`, which `compile-structs` reads. That is
  how code running *inside* a standalone knows, from its own linked runtime, which backend it
  is — used to pick cache dirs (below) without any global flag.
- `js-of-pyret.arr`'s `trace-make-compiled-pyret` dispatches on `options.stack-backend`:
  `promise` → the async ANF→JS compiler (`anf-loop-compiler-async.arr`), everything else →
  the original (`anf-loop-compiler.arr`).
- `standalone-configA-async.json` is the async build config: identical to
  `standalone-configA.json` except it maps `pyret-base/js/runtime.js → runtime-async.js`.

The async compiler and runtime are **copies** of the originals (`anf-loop-compiler-async.arr`,
`runtime-async.js`), committed verbatim before editing, so diffs against the Cont versions
stay legible and the Cont path is untouched.

### 2. Codegen: a completion-passing straight-line walk (replaces the trampoline)

The Cont backend is built entirely on **splitting**: `compile-split-app/if/cases` emit
`switch(step)` state machines inside a `while(!isContinuation(ans))` trampoline that pops
`ActivationRecord`s off `theOneTrueStack`. The async backend needs **none** of it —
`async`/`await` suspends natively and heap-allocates the suspended frame.

The async emitter is a straight-line walk over ANF driven by a **completion** function:

- Each tail expression's final value flows into `compiler.complete` — a field set to *return
  it*, *assign it to a binding*, or *discard it*. A `tail-pos` boolean gates TCO.
- `a-if` / `a-cases` push the **same** completion into both branches → no join point, no
  case-splitting.
- The `AExpr` visitor methods (`a-let`/`a-arr-let`/`a-var`/`a-seq`/`a-lettable`/`a-type-let`)
  return blocks with `new-cases` always empty; `compile-aexpr-async` is just
  `e.visit(compiler).block.stmts`.
- New dispatchers: `compile-lettable-async`, `compile-app-async` (including while-loop TCO via
  `get-assignments` + `j-continue`), `compile-method-app-async`, `compile-update-async`,
  `compile-cases-async`/`-branch-async`, `ann-check-stmts`, `complete-return`.
- `compile-fun-body` emits `if(needsPause()) await checkPause()` at entry (non-flat fns only),
  optionally wrapped in `while(true){…}` for TCO, plus per-argument annotation checks at the
  top of the loop body (re-checked on each TCO re-entry, matching Cont's `step=0` reset).
- Value-producing visitor methods (`a-id`, `a-dot`, `a-obj`, annotations, …) are reused
  unchanged.

Two small **additive** variants were added to the shared `js-ast.arr` (match-based visiting, so
the Cont backend is unaffected): `j-async-fun` (`async function`) and `j-await` (`(await e)`).
A flat lambda stays a plain `j-fun`; a non-flat one becomes `j-async-fun`.

### 3. Runtime: `runtime-async.js`

- `needsPause()`: decrements `GAS` (recursion depth) and `RUNGAS` (time proxy); returns true
  when either hits 0 (and resets it).
- `async checkPause()`: throws `userBreak` if the break flag is set (Stop button); on `RUNGAS`
  expiry additionally yields a **macrotask** (`await new Promise(r => util.suspend(r))`) so the
  host event loop can run; otherwise the natural microtask of `await f.app` already unwinds the
  synchronous JS stack. In **sync mode** (`options.sync`, used by the self-host bootstrap)
  `RUNGAS = Infinity` so it never yields a macrotask.
- `async run(...)`: keeps the `RUN_ACTIVE` guard and the `SuccessResult`/`FailureResult`/
  `getStats` contract; the body is `onDone(new SuccessResult(await program(...), stats))`.
- `async runStandalone(...)`: awaits each module fn in dependency order. (The original
  trampoline version stored an unresolved promise then `process.exit`'d before the program ran
  — the cause of an early "exit 0, no output" bug.)
- `pauseStack(resumer)` returns a **real Promise** that settles when the resumer calls
  `restarter.resume/.error/.break`. This is what made check-result reporting work: the
  postLoadHook's `pauseStack` + `runThunk` idiom drives check summaries identically to Cont.
- Many runtime helpers that call user code were converted to `async`/`await` (see below).

## The central invariant: flatness ⟺ async-ness

This is the one mental model the whole backend hangs on:

```
flat (flatness ≤ 5)  ⟺  emitted sync  j-fun       ⟺  no await at call site  ⟺  returns a value
non-flat             ⟺  emitted async j-async-fun ⟺  awaited at call site   ⟺  returns a Promise
```

**Every** await decision — call, method-app, update, annotation check, primitive app — *and*
the function-emission decision (sync vs async) must use the **same** flatness verdict from
`flatness.arr`. Get them out of sync and you get one of two failures:

- a flat fn (emitted sync `j-fun`) containing an `await` → JS **syntax error** ("await is only
  valid in async function"); or
- a non-flat call left un-awaited → a raw `Promise` leaks into a value or a `_checkAnn` →
  the runtime's "Non Pyret value: Promise" error.

Two flatness-consistency bugs were fixed in the compiler to honor this: modref calls now
compute `get-flatness-for-module-call` instead of always-awaiting, and `ann-check-stmts` gates
its `_checkAnn` await on `is-flat-enough(ann-flatness(...))` so flat annotations check
synchronously.

Correspondingly in the runtime, the rule is: a *flat* runtime helper returns a value
synchronously; any helper that calls user code (`f.app`, `full_meth`, `_equals`, `_output`) is
non-flat and must be `async`/awaited. Converted under this rule: `raw_list_map/filter/fold`,
`raw_list_join_str_last`, the `raw_array_*` builders/mappers/folds, `eachLoop`, `toReprLoop`
(rewritten as a straight-line async stack machine), `equal3`'s core (awaits user `_equals`),
and `execThunk` (run-task, now an inline `await` + try/catch returning an `Either`). `safeCall`
was made **thenable-aware**: it stays synchronous when `fun`/`after` are flat and returns a
Promise only when `fun()` actually returns a thenable — which is what keeps the statically-gated
`_checkAnn` await consistent with the dynamic value.

## Safe-for-space tail calls (bounce token + driver)

A **self** tail call already compiles to a `while(true){…;continue}` loop → O(1). A **mutual**
(cross-function / higher-order / cross-module) tail call used to compile to `return await
g.app(…)`, which is **not** a JS tail call: each level suspends a heap-allocated async frame the
level above retains, so the chain is O(n) live frames. GAS bounds the *native* stack (it never
overflows) but cannot reclaim the suspended-frame chain. Measured on
`tests/async-opt/bench-mutual.arr` (`is-even`/`is-odd`, no return anns so the call is genuinely
tail): promise grew ~626 B/level and OOM-aborted around 5M deep, while cont stayed flat ~136 MB.
No JS engine helps — only JavaScriptCore ever shipped Proper Tail Calls; V8 removed its flagged
implementation. `await`, no-`await` (promise adoption), and `Promise<Promise>` flattening are
**all O(n)**: the leak is the result-dependency chain, not the frames or the native stack.

The fix is a **bounce token + driver**, with the polarity chosen so the *safe* path is the
default:

```js
function TailCall(fn, args) { this.fn = fn; this.args = args; }
thisRuntime.tailCall = (fn, args) => new TailCall(fn, args);

// makeTailFunction wraps a token-minting body. Public `.app` DRIVES to a value;
// internal `appBody` (=== the body) may return a token at a tail position.
function makeTailFunction(fun, name) {
  var f = new PFunction(fun, fun.length, name);   // f.appBody === fun
  f.app = async function() {                       // closure over `fun`
    var r = await fun.apply(this, arguments);
    while (r instanceof TailCall) r = await r.fn.appBody.apply(r.fn, r.args);
    return r;
  };
  return f;
}
```

- **`PFunction` now carries both `.app` and `.appBody`.** The constructor defaults
  `appBody === app`, so every plain/FFI/builtin function *ends* a bounce chain by returning a
  value (it anchors one frame — correct, and the opt-in to do better is to supply a token-minting
  `appBody`). Only token-producing compiled functions get the driver as `.app`.
- **The compiler mints a token at a genuine tail position** (completion is `complete-return`),
  inside an async body, when the callee is **non-flat** — emitting `return R.tailCall(f, [args])`
  instead of `return await f.app(args)`. A *flat* callee can't recurse deeply, so it keeps its
  cheap direct return and forces no driver. Self tail calls keep the `continue` loop (no
  per-iteration token alloc). The decision is recorded per-function in a mutable cell threaded on
  the compiler; `compile-a-lam` then emits `makeTailFunction` iff the body actually minted a
  token, else plain `makeFunction` — so `fib` and every non-tail-recursive function keep
  `.app === .appBody` and pay **zero** overhead.
- **Why this polarity.** The public `.app` always returns a value, so every FFI / JS-to-Pyret /
  non-tail / loop-helper call site is unchanged and correct — `await f.app(args)` is always a
  value, never a token. Loop helpers (`map`, `fold`) *consume* their callback's result, so they
  are drivers by definition. Tokens are never observable as Pyret values: they exist only in
  transit between an `appBody` return and the driver. (Guarded by
  `tests/async-opt/mutual-tco-test.arr`, which feeds deep mutual / 3-cycle / higher-order
  tail-recursion results through `==`, arithmetic, predicates, and `is` — a leaked token would
  surface as a "Non Pyret value".)
- **The driver closes over `fun` rather than reading `this.appBody`.** This is essential, not
  cosmetic: several call sites invoke `.app` with `this` **unbound** — `cases` dispatch does
  `self.$app_fields(getField(handlers, name).app, …)`, and trove FFI re-exposes a Pyret function's
  `.app` under another name (`make-reactor`, `place-image`, …). A driver that read `this.appBody`
  crashes at every such site (`Cannot read properties of undefined`); a closure over `fun` does
  not. (`PFunction.prototype.brand` likewise detects a token-producing function by
  `this.app !== this.appBody` to re-wrap it correctly.)

Result: `bench-mutual` is now **O(1) in heap** — flat ~132/133/155 MB at depth 1M/5M/20M (cont is
~136 MB), where promise previously OOM'd at 5M. The whole `is-even`⇄`is-odd` chain runs as
iterations of one driver frame's loop; each `appBody` frame returns a token and dies. Coverage is
fully dynamic (the token references a runtime function *value*), so higher-order, first-class, and
cross-module tail calls are all safe-for-space, not just statically-named groups.
Return-annotated tail calls (`fun f(…) -> T:`) stay non-tail on both backends by design (the ann
check consumes the result), so they are driven, not bounced.

**Methods participate too.** A tail call *through a method* (`self.od(n-1)` ⇄ `self.ev(n-1)`) is
also O(1). `PMethod` gained the same split — `full_methBody` (default `=== full_meth`, so a plain
method ends a chain) and a driving `full_meth` installed by `makeTailMethod` — and a second token
kind `TailMethodCall(m, obj, args)` carries the receiver. The **single** `drive()` loop pumps both
`TailCall` and `TailMethodCall`, so a mixed function⇄method chain (a method tail-calls a free
function which tail-calls the method) stays flat through one driver. The compiler mints the method
token via a `maybeMethodTail(obj, name, loc, …args)` resolver — it returns a `TailMethodCall` for a
method field or a `TailCall` for a function field, throwing the same `throwNonFunApp` for a
non-callable; `compile-a-method` emits `makeTailMethod*` exactly when the body minted (else plain
`makeMethod`). Heap-verified: a method `ev`⇄`od` is flat ~150 MB at 1M–20M (was O(n)). The hot
function path is unchanged — `drive()` checks `TailCall` first and short-circuits, and `bench-mutual`
holds at ~0.58 s / 155 MB.

## Caching: backend-keyed, never mixed (the #1 hazard)

Cont- and promise-compiled modules share a **source-only** hash but emit **incompatible** JS
(sync trampoline vs `async`/`await`). Loading one on the other backend silently runs e.g. a
Cont-compiled `lists` (no `await f.app`) on the async runtime → a Promise leaks into a deep
annotation check.

So caches are **backend-keyed**:

- promise builtins → `compiled-promise/`; suite → `tests/compiled-promise/`; bootstrap →
  `build/phase?-promise/`.
- Cont → `compiled/`, `tests/compiled/`, `build/phase{A,B,C}/`.

Crucially, the **nested-compilation** path (`run-task` / `run-str` →
`compile-and-run-locator`) used to load builtins from the *Cont* cache dirs even on the promise
host. Fixed: `default-compile-options.compiled-cache` (compile-structs.arr) and the
`default-{start,test}-context` cache dirs (cli-module-loader.arr) resolve to
`./compiled-promise` when `compiled-stack-backend` is `promise`. Resolution happens at runtime
from the standalone's own linked runtime, so the Cont path is never affected. This single fix
cleared the entire nested-run cluster (test-contracts, test-error-rendering, test-include).

## Results

### Suite — `make all-pyret-test-promise`

**Passed 13008, Failed 8, Errored 0 / 13016.** Every test file is at full parity with the Cont
backend except the 8 failures below, all in `test-repl` `check-block-6` (frame-shape stacktrace
pins — see *Known divergences*). Per-file highlights at parity include test-equality (6168),
test-strings (1125), test-array (637), test-rounding (401), test-lists (379), test-contracts
(165), test-error-rendering (58), test-include (57), plus numbers/sets/json/tuples/tables/etc.
(The raw assertion totals drift by a few between runs — `test-pprint` generates a
nondeterministic count — so compare the *failing set*, not the total.)

Known **parity** failures (Cont *also* fails — not promise gaps): test-within (3), test-roughnum
(1), test-pprint (both time out), test-each-loop / test-include-block (both compile-error
standalone).

### Bootstrap — `make new-bootstrap-promise`

The compiler self-hosts on the async backend and converges to a **byte-stable fixpoint**:

```
phaseA (cont)  --promise-->  phaseB        (seed: cont-built promise compiler)
phaseB         --promise-->  phaseC        (C != B)
phaseC         --promise-->  phaseD        (D != C)
phaseD         --promise-->  phaseE        (E == D  ✓ fixpoint)
```

Findings:

- **Promise compilation is deterministic given a fixed compiler** — the *same* compiler run
  twice produces byte-identical output. The async backend is reproducible; the macrotask /
  async-I/O ordering worry does not materialize for compilation.
- The chain converges **one generation later than Cont**. The lag is purely a seeding artifact:
  the seed (phaseB) is *assembled by the Cont compiler*, whose internal module/gensym ordering
  differs slightly from a promise-built one. That perturbs only **data** embedded in the output
  — gensym atom names (`atom#a#10` vs `…#19`) and dependency-list order in `define("program",
  [...])` — never logic. Once the builder is itself promise-built-by-promise (phaseD onward),
  the output is stable: `D == E`.
- Each of phaseC/D/E is a **working** compiler, not just matching bytes — each compiles and runs
  real programs correctly (spot-checked with factorial + `lists.sort`).

This is the async analogue of Cont's `new-bootstrap` (which diffs phaseB vs phaseC); the
promise target diffs the converged pair phaseD vs phaseE.

## Performance — benchmarks (`tests/async-opt/`)

Six microbenchmarks (pulled from a parallel optimization effort) measure the async backend's
overhead vs the cont/trampoline backend. Each is pure compute that prints one number; timing is
wall-clock of `node bench.jarr` (built `-no-check-mode`), cont = `bench.jarr`, promise =
`bench.p.jarr`. The async backend's intrinsic cost is the per-call `await` (a microtask) plus a
periodic macrotask yield (every `INITIAL_RUNGAS` = 5000 steps) — the "await tax".

**A TCO bug the benchmarks surfaced (now fixed — `anf-loop-compiler-async.arr`).** The first runs
showed a pathological 8.5× on `bench-tco` and an **out-of-memory crash** on `bench-flat`. Root
cause: a return-type annotation defeated TCO. `fun f(...) -> T:` desugars its tail self-call into
`let ans = f(...) in _checkAnn(T, ans)`, so the call is let-bound; the async TCO test gated on the
syntactic `compiler.tail-pos` (false inside a let), so the loop never engaged and every iteration
awaited + retained an async frame → O(n) heap (slow, and OOM past ~20M deep). The cont backend
keys TCO on the ANF's authoritative `app-info.is-tail` instead, which is true here. Fix: drop the
`tail-pos` gate and trust `app-info.is-tail` (+ `in-tco-loop` so the `continue`-target exists), as
cont does. `continue` skips the per-iteration `_checkAnn`, which is sound — the returned value is
the base case's already-checked value (cont's trampoline skips it identically). Verified: full
promise suite still 12997/13002 (only the 5 stacktrace pins fail, no new failures); the
annotated 5M-deep tail loop dropped from 16.5s/3.7 GB to 3.0s/139 MB, matching the unannotated
case.

**Two later optimizations closed most of the remaining gap (`runtime-async.js`).**

1. **`util.suspend` instead of `setTimeout(0)` for the macrotask yield.** This was the dominant
   cost. `checkPause()` yielded its interruptibility macrotask via `await new Promise(r =>
   setTimeout(r, 0))`, but **node clamps `setTimeout` to a ~1 ms floor**. At one yield per
   `INITIAL_RUNGAS` = 5000 steps, a tight 80M-iteration loop does ~16k yields ≈ 16s of pure timer
   clamp. The cont trampoline never paid this because it has always suspended via `util.suspend`
   (`setImmediate` in node, `postMessage` in the browser, `setTimeout` only as last resort).
   Switching `checkPause` to the same `util.suspend` removed the clamp with no loss of
   interruptibility. *This alone took `bench-map` 2.4× → 1.2×, `bench-tco` 2.8× → 1.6×.*
   - Diagnostic that isolated it: patching the built standalone to (a) drop the stack counter and
     (b) drop all yields showed the stack counter's microtask yields are nearly free (2.36× vs
     2.37×), while removing yields entirely collapsed the gap (0.92×) — so the cost was the
     *kind* of macrotask, not the counters. (The trampoline also re-increments `GAS` on return so
     it tracks live depth rather than operation count; we don't, but since those yields are cheap
     microtasks it doesn't move the benchmark.)
2. **Conditional per-element `await` in the loop helpers** (`raw_array_map/each/mapi/map1/fold/
   build/build_opt/bool_mapper`, `raw_list_map/filter/fold`, `raw_list_join_str_last`,
   `eachLoop`). Each helper still charges fuel *before* the callback (`if (needsPause()) await
   checkPause()` — this is what bounds re-entrant flat callbacks; see the `helper-reentry` guard),
   then does `var res = f.app(x); ... isThenable(res) ? await res : res`. A **flat** (synchronous,
   value-returning) callback skips the per-element microtask entirely; a non-flat callback returns
   a thenable and is awaited exactly as before. Soundness: the thenable test is the robust
   `res && typeof res.then === "function"` shared with `safeCall` (a false negative would leak a
   Promise), and fuel stays *before* the call so the re-entry bound is unchanged. This is the same
   shape the parallel effort shipped — but they charged fuel only on the flat branch *after* the
   call, leaving a re-entry overflow hole; charging first closes it (our `helper-reentry` guard
   asserts the deep cases stay bounded where theirs overflows).

Results (best of 3 timed runs; all outputs verified byte-equal across backends):

| benchmark | shape | cont | promise (pre-fix) | promise (post-opt) | ratio |
|---|---|---|---|---|---|
| bench-flat | annotated tail, 20M deep, flat-builtin calls | 21.8s | **OOM** | 23.8s | **1.09×** |
| bench-listsum | annotated tail, list build+sum | 5.8s | 23.1s | 6.0s | **1.04×** |
| bench-nontail | non-tail `fib` (TCO N/A) | 8.2s | 19.4s | 11.5s | **1.41×** |
| bench-map | shallow tail driver + flat `map`/`fold` | 15.7s | 45.0s | 18.7s | **1.19×** |
| bench-tco | annotated tail, 200k deep × 200 | 7.9s | 66.3s | 13.8s | **1.75×** |

For comparison, the parallel optimization effort (which dropped the stack counter and the
per-iteration fuel charge, leaving the re-entry overflow) reported flat 1.0×, listsum 1.7×, map
1.0×, nontail 1.65×, tco 2.1×. We now **beat it on listsum/nontail/tco** and are close on
flat/map — while keeping the stack-safety guarantee it gave up.

Reading the numbers:

- The annotated-tail benchmarks (flat/listsum) are at **near-parity (1.04–1.09×)** — TCO restored
  + the macrotask-yield fix.
- `bench-map` (the conditional-await target) dropped 2.7× → **1.19×**; the per-element await on its
  flat `map`/`fold` callbacks is now skipped.
- `bench-nontail` (1.41×) and `bench-tco` (1.75×) carry the genuine residual **await tax**: a
  microtask per non-flat call, inherent to compiling every call to `await f.app`. `fib` is truly
  non-tail (one await per recursive call); the TCO loop awaits each iteration's body. This is the
  floor of the async model and cannot be removed without changing it.
- On real, mixed workloads (the full suite, `test-numbers`, the bootstrap self-compile) the async
  backend runs at roughly **1.0×** — jsnums arithmetic, parsing, and library work dominate, and
  the await tax only becomes visible in these deliberately await-bound tight loops.

**Re-measured after the safe-for-space tail-call work** (best of 3; outputs byte-equal across
backends), confirming the selective driver hop lands only on token-producing functions and leaves
the hot non-token paths untouched:

| benchmark | shape | cont | promise | ratio |
|---|---|---|---|---|
| bench-flat | annotated tail, 20M deep | 21.6s | 22.9s | 1.06× |
| bench-listsum | annotated tail, list build+sum | 5.7s | 6.3s | 1.11× |
| bench-nontail | non-tail `fib` | 8.1s | 11.8s | 1.47× |
| bench-map | shallow tail driver + flat `map`/`fold` | 15.7s | 18.4s | 1.17× |
| bench-tco | annotated tail, 200k × 200 | 7.7s | 13.2s | 1.71× |
| bench-boids | image construction (real workload) | 21.7s | 29.7s | 1.37× |
| bench-boids-raster | color-at-position rasterization | 5.0s | 6.4s | 1.29× |

All ratios are within measurement noise of the pre-feature numbers (flat 1.09, listsum 1.04,
nontail 1.41, map 1.19, tco 1.75, boids 1.32, raster 1.24) — the deltas are symmetric (some
better, some worse). Crucially `bench-tco` (self-recursion → `continue` loop), `bench-nontail`
(non-tail), and `bench-flat` (flat) — the cases that would regress if the extra `.app → appBody`
hop landed broadly — are unchanged, which is the empirical proof of selectivity (~30% of stdlib
functions get `makeTailFunction`, but none on these hot paths).

**`bench-mutual` is the safe-for-space *acceptance*, not a speed ratio.** It measures heap, not
time: promise is now flat ~132/133/155 MB at depth 1M/5M/20M (cont ~136 MB), completing 20M-deep
mutual recursion in ~6s — where it previously grew ~626 B/level and OOM-aborted at 5M. See *Safe-
for-space tail calls* above.

## Known divergences and gaps

- **Stack-trace shape (the 8 suite failures).** The spec explicitly anticipates this: async
  frames are heap-allocated and V8 adds `await` frames, so any test that pins an exact frame
  list (`get-result-stacktrace(...) is [raw-array: ...]`) diverges from the trampoline's
  `ActivationRecord`-derived list — e.g. the bottom `interactions://1` REPL-call frame is absent
  and TCO frames aren't collapsed the same way. **Error *detection* is correct**: every
  interleaved `satisfies is-failure-result` check passes; only frame shape (and now length)
  differs. The count grew from 5 → 7 → 8 as the safe-for-space work landed: a **tail call to a
  non-flat callee now collapses the caller's frame** (the `appBody` frame bounces away — exactly
  the O(1) behavior), where cont keeps it because its trace comes from a separate
  `ActivationRecord` stack. So e.g. `fun g(): f(x) end` (f non-flat, tail) shows just the error
  site on promise vs `[error-site, g's call site, interactions://]` on cont; extending this to
  method-apps (a method tail-call now collapses its frame too) added the 8th. Same family as the
  original divergence, made slightly broader by a correctly-implemented feature; the innermost
  (error-site) frame is still correct in every case. (Correspondingly, the portable
  `test-stacktrace-portable.arr` no longer asserts caller-frame presence or `st-len` for tail
  calls through loop helpers — frame *count* there is not portable: the identical code shows ≥2
  frames inside the aggregate suite but 1 standalone, because async await-unwinding leaves only
  what is synchronously on the JS stack at throw time. It still asserts detection + the innermost
  error-site frame, and passes 70/70 on both backends.) Per the
  spec, these are flagged, not "fixed". Following the spec's second instruction ("write new
  tests that work under both backends to make sure your behavior is sensible"), a new test file
  **`tests/pyret/tests/test-stacktrace-portable.arr`** re-exercises the same error scenarios and
  asserts only the portable properties — (1) the error is detected, (2) the innermost frame
  (index 0) is the actual error site, (3) the user's definition-site frames are present, (4) the
  trace is non-trivial — without pinning total length, the bottom `interactions://` repl frame,
  or TCO/recursion frame collapsing. It is imported by `tests/pyret/main2.arr`, so it runs in the
  normal suite on both backends (`make all-pyret-test` and `make all-pyret-test-promise`) and
  passes 74/74 on each. The existing pinned `test-repl` assertions can be deprecated in a later
  pass. (Notable observed extreme: a deep non-tail `sum(1000)` error yields ~1002 frames under
  cont but collapses to a single innermost frame under promise, since the async frames are
  unwound by `await` before capture — both still pinpoint the error site.)
- `makeDataTypeConstructor` emits a *sync* `_checkAnn` for data-field annotations. Fine for flat
  refinements (validated); a non-flat/async refinement on a data field would leak a Promise.
- The CPO-side acceptance leg — `npm run mocha` (selenium browser integration tests in
  `code.pyret.org/`) — is now **exercised and green on both backends** (the "unrunnable on this
  headless VM" claim was a false assumption; headless Chrome runs here). See the new
  *code.pyret.org (CPO) integration* section below for the full story and results.

## code.pyret.org (CPO) integration

The intended design endgame: make **code.pyret.org build and run on either backend**, side by side,
and pass the third acceptance leg — `npm run mocha` (CPO's selenium browser integration tests). This is
done. **The full mocha suite is at parity on both backends: 311 passing / 0 failing / 45 pending,
byte-identical on cont and promise** (the 45 pending are skipped on both — Google-OAuth/DB/embed infra
not configured on this VM, not a backend gap). CPO is **untouched on the cont path** — every change is
additive and either CPO-side or in the promise runtime only.

### Both-backend build plumbing (additive; cont path unchanged)

- `code.pyret.org/pyret` is a symlink to the pyret-lang root (`../lang`); CPO builds `cpo-main.arr`
  with `pyret/build/phaseA/pyret.jarr` — the same `--build-runnable` path used in `lang/`.
- **`cpo-config-async.json`** is the promise require-config: a copy of `cpo-config.json` with the one
  line `pyret-base/js/runtime.js → pyret/build/phaseA/js/runtime-async.js`.
- **`make web-promise`** (a new, additive Makefile target) builds `cpo-main.arr` with
  `--stack-backend promise --require-config cpo-config-async.json --compiled-dir ./compiled-promise`
  into a **separately-named** `build/web/js/cpo-main-promise.jarr`, in the **same** `build/web` so the
  static assets are shared. Caches are backend-keyed (`compiled/` vs `compiled-promise/`, never mixed —
  the #1 hazard). The cont jarr is byte-identical to before. The whole CPO codebase (`cpo-main.arr` +
  all CPO trove + the pyret stdlib, 119 modules) compiles clean under the async backend with **no
  source changes**.
- **Side-by-side servers need no `server.js` change.** The editor loads its jarr from `window.PYRET`
  (the `PYRET` env, injected at render time) via the static middleware, so cont and promise run as two
  server instances over the same `build/web`, differing only by `PYRET` + `PORT`:
  ```
  # cont
  node -r dotenv/config src/run.js                       # :4999, PYRET=…/cpo-main.jarr
  # promise
  PORT=5999 BASE_URL=http://localhost:5999 \
    PYRET=http://localhost:5999/js/cpo-main-promise.jarr \
    node -r dotenv/config src/run.js
  # run a test against either:  BASE_URL=http://localhost:PORT npx mocha test/X.js --timeout 120000
  ```
  The server boots without redis/postgres/Google (all optional for serving `/editor`).

### Two promise-only bugs found and fixed

Both are the same family the spec warned about — a site assuming a call returns a **synchronous value**,
which holds on cont but yields a `Promise` (or a guard rejection) on promise. Both were diagnosed by the
"patch the built standalone to instrument" technique (the jarr is a self-contained, gitignored artifact;
`code.pyret.org/test-util/console-probe.js` loads `/editor` headless and dumps the browser console + an
optional REPL eval).

1. **The editor wouldn't load — `pauseStack` kept a paused run `RUN_ACTIVE` (`runtime-async.js`).**
   CPO's REPL runs every interaction via a **same-runtime nested run** so definitions persist —
   `runtime.pauseStack(… runtime.runThunk(…) …)` in `load-lib.js`'s `run-program`. On cont this works
   because a paused trampoline unwinds and is no longer "active"; on the async backend `pauseStack`
   merely returned a Promise the outer run `await`ed, leaving the outer run `RUN_ACTIVE`, so the nested
   `run` was rejected with *"Internal: run called while already running."* That failure's exn was a raw
   Pyret value with no JS `.stack`, which then crashed the stack-parser — so a stack-trace difference
   had **semantic impact** (it aborted the whole editor load), not a cosmetic divergence. **Fix:
   `pauseStack` releases `RUN_ACTIVE` on pause and restores it on resume/error/break**, exactly
   mirroring the cont trampoline's unwind. Validated: `all-pyret-test-promise` stays **13008/8/0
   (byte-identical to baseline)** and `async-opt-test` is all green — no node regression.

2. **Check/error-failure rendering raised `field-not-found` — `equal_always` used as a sync boolean on
   objects (`output-ui.js`).** CPO's loc→AST `search` resolves a source location to its exact AST node
   (so the checker can highlight the failing sub-expression). It used `runtime.equal_always(l, loc)` and
   the srcloc `contains` method as synchronous booleans. On the async backend **`equal_always` on two
   flat *objects* returns a `Promise`** (`equal3`'s `equalHelp` is an `async function`, so even its
   no-await flat path returns a thenable; only `identical3` and JS-primitive comparisons stay sync).
   A truthy `Promise` made `if (equal_always(...))` always match, so `search` returned the first
   non-ignorable node (the enclosing `s-check` block) instead of the exact `s-check-test`, and the
   checker's `test-ast.left` (`checker.arr:36`) hit `field-not-found`. **Fix: compare flat srclocs
   synchronously on their char offsets in `search`** (the function's own comment already certifies
   "srclocs are flat data"), avoiding `equal_always`/`contains` entirely. Result: promise check-blocks
   **11→29/29** and errors **54→193/193**; cont re-verified 29/29 + 193/193 (the char-offset compare is
   semantically equivalent to `equal_always`/`contains` for srclocs — no cont regression).

### Results — `npm run mocha`, both backends (per-file)

`311 passing / 0 failing / 45 pending`, **identical on cont and promise.** Highlights: `errors` 193,
`image-equality` 64 (headless canvas/image trove), `check-blocks` 29, `chart` 10 (vega/d3), plus
`world`, `tables`, `type-check`, `pyret` (image programs), `basic`, `number`, `embed` all at parity.
The 45 pending (`shareUrls` 37, `modules` 5, `sheets` 2, `embed` 1) are skipped on both backends. No
CPO-trove `.js` needed a `stackBackend` branch for what the suite exercises.

### Audit — the `equal_always`/`.app`-as-sync-boolean-on-objects pattern (done)

The forward-looking caution above was swept systematically. The bug class precisely: on the promise
backend a JS→Pyret call (`X.app(...)`, `.full_meth(...)`, `runtime.equal_always`/`equal_now` on
**objects**) returns a **Promise**, and the bug bites only when JS consumes that result *synchronously*
(an `if`/`&&`/ternary/`.filter`, arithmetic, a field access — a truthy Promise silently passes). Flat
callees (type predicates like `is-Srcloc`, simple accessors, and **`srcloc.format`** — only string `+`
and `tostring`-of-number) stay sync on both backends and are safe; results consumed via
`safeCall`/`.then`/`runThunk`/`restarter.resume` or *returned out of a `makeFunction` to async-aware
compiled Pyret* are also safe (the consumer awaits).

- **All CPO web JS (`code.pyret.org/src/web/js/*.js`): clean.** The only `equal_always` site was the
  already-fixed `output-ui.js` `search`. Every `.app` site either calls a flat callee (predicates,
  `format`, brand application, data constructors) or is consumed async-aware. (`format`/`brand`/JSX
  flags raised during the sweep are false positives — those callees are flat; corroborated by `errors`
  193/193 in mocha, which renders locations through `format`.)
- **`lang/src/js/trove/table.js`: clean.** Both `equal_always` sites are consumed via a `safeCall`
  continuation / returned out of a `makeFunction` into async-aware `stable-sort-by`.
- **`lang/src/js/trove/image-lib.js`: one *real* bug, found and fixed** (below).

### Image color equality — a real promise-only bug (found by the audit, fixed)

Images are opaque values whose `.equals` the runtime invokes **synchronously** (the `isOpaque` branch
of `equal3`, via `makeOpaque(i, image.imageEquals)` in `make-image.js`/`charts-lib.js`). Several image
`.equals` methods compared colors with `equals(this.color, other.color)` where `equals =
RUNTIME.equal_always`. A `color` is a data-value **object**, so on promise `equal_always` returned a
truthy `Promise` consumed in a synchronous `&&` → **two same-size/same-vertex images differing only in
color compared *equal*.** Reproduced: `circle(30,"solid","red") == circle(30,"solid","blue")` →
`true` on promise, `false` on cont. (Most tests escaped it because interned color *strings* hit
`equal_always`'s primitive fast path, and size/shape mismatches short-circuit before the color compare.)

**Fix** (`image-lib.js`): a synchronous `colorEquals` that mirrors `equal_always`'s structural compare
of the `Color` data value — channel-wise `jsnums.equals` on `red/green/blue/alpha` when both are
colors, else strict `===` (matching the primitive fast path) — replacing `equal_always` at the 4 color
sites (`BaseImage`, `TextImage`, `EllipseImage`, `WedgeImage`; the other types route through these).
A regression check is committed in `tests/pyret/tests/test-images.arr` (covering all four colored image
types with distinct-but-equal color objects + an alpha case); it runs in both `make all-pyret-test` and
`make all-pyret-test-promise` (bundled via `main2.arr`). Validated **153/153 on both backends** (was
147; the 6 new assertions would have failed before the fix), full promise suite 13014/8 (the 8 are the
unchanged `test-repl.arr` stacktrace pins); cont unchanged.

**Watch (still latent, lower priority):** the bug class is "non-flat result consumed synchronously by
JS." The remaining theoretical surface is any *future* JS that calls `equal_always`/a non-flat method
and uses the result in the same JS function without `safeCall`/`.then`. The opaque-`.equals` path is
the sharp edge (only images use a custom structural equals); all other troves use single-arg
`makeOpaque` (identity equals, sync).

## Build / debug notes (for the next person)

- One-time: `cd lang && npm install` (the VM ships an empty `node_modules`; browserify is needed).
- Compiler gate after editing any compiler `.arr`: `make phaseA` (~1–2 min). After editing only a
  runtime/trove `.js`: `cp src/js/base/runtime-async.js build/phaseA/js/`, then
  `rm -rf compiled-promise` and rebuild.
- **`rm -rf compiled-promise` after any compiler/runtime change** — stale cached promise modules
  were the single biggest red herring (an old module compiled before a fix reads like a live bug).
- Run built `.jarr`s from inside `lang/` (node walks up for `node_modules`).
- The leak debugging method that cracked the hard bugs: a `Promise` reaching `_checkAnn` is the
  universal symptom. Temporarily add to `runtime-async.js` `_checkAnn`:
  `if (val && typeof val.then === "function") CONSOLE.error("LEAK", JSON.stringify(compilerLoc),
  ann && ann.name)`. `compilerLoc` is a `["builtin://MOD", line, col, …]` srcloc that names the
  exact module + line — it pointed straight at the Cont-compiled `lists.arr:475` and exposed the
  cache mismatch.
- Stack-depth regression test for the fuel model: `lang/tests-promise/stack-depth.arr`.
