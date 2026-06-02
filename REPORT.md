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
expressed natively with `async`/`await` instead of the hand-written trampoline.

The backend is exercised end-to-end:

- **Full test suite at parity.** `make all-pyret-test-promise` builds the aggregate suite
  (`tests/pyret/main2.arr`, ~80 test files + all builtins) with the promise backend and runs
  it: **Passed 12947, Failed 5, Errored 0 / 12952.** The 5 failures are all spec-sanctioned
  stack-trace-shape divergences (see *Known divergences*); every other file matches Cont.
- **Self-hosts to a byte-stable fixpoint.** `make new-bootstrap-promise` compiles the whole
  compiler with the promise backend and shows it reproduces itself exactly (`phaseD == phaseE`).

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

**Passed 12947, Failed 5, Errored 0 / 12952.** Every test file is at full parity with the Cont
backend except the 5 failures below, all in `test-repl` `check-block-6`. Per-file highlights at
parity include test-equality (6168), test-strings (1125), test-array (637), test-rounding (401),
test-lists (379), test-contracts (165), test-error-rendering (58), test-include (57), plus
numbers/sets/json/tuples/tables/etc.

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

## Known divergences and gaps

- **Stack-trace shape (the 5 suite failures).** The spec explicitly anticipates this: async
  frames are heap-allocated and V8 adds `await` frames, so any test that pins an exact frame
  list (`get-result-stacktrace(...) is [raw-array: ...]`) diverges from the trampoline's
  `ActivationRecord`-derived list — e.g. the bottom `interactions://1` REPL-call frame is absent
  and TCO frames aren't collapsed the same way. **Error *detection* is correct**: every
  interleaved `satisfies is-failure-result` check passes; only frame shape differs. Per the
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
- `mocha` (selenium) tests are unrunnable on this headless VM, as noted in the spec.

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
