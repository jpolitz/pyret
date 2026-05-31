# Async-function compiler backend for Pyret — report

## Goal

Add a new compiler backend that represents every compiled Pyret function as a
JS `async function`, every Pyret call as `await f.app(...)`, and the fuel
meter (`GAS`/`RUNGAS`) as an `await checkPause()` at the top of each function —
the "Stopify-in-50-lines" idea from `async-email-demo.md`. The JS engine manages
the stack; `await` gives deep stacks and user interruption for free. Selectable
by a compiler flag; the existing trampoline backend is unchanged.

## How to build / run

```
# default backend (unchanged)
make all-pyret-test           # full Pyret test suite
make new-bootstrap            # phaseB == phaseC fixpoint

# async backend (new targets; nothing existing was modified)
make foo.async-jarr           # build any foo.arr with -async-backend
make all-pyret-test-async     # full suite under the async backend
```

The async build uses a separate `tests/compiled-async/` module cache (the
on-disk cache key is source-hash only — not backend or check-mode — so async-
and trampoline-compiled output for the same URI must never share a directory).

## What was built

### 1. Flag plumbing (small, config-style diffs)
- `compile-structs.arr`: `async-backend :: Boolean` on `CompileOptions` (default `false`).
- `pyret.arr`: `-async-backend` CLI flag, threaded into the build-runnable options.
- `js-of-pyret.arr`: routes codegen to the async backend when `options.async-backend`.

### 2. Additive JS AST nodes (`js-ast.arr`)
- `j-fun-async` — emits `async function ...`.
- `j-await` — emits `(await <expr>)`.
Purely additive; the trampoline backend never emits them.

### 3. Async code generator (`anf-loop-compiler-async.arr`)
A copy of `anf-loop-compiler.arr` whose control-flow core is replaced by a
recursive `compile-e(compiler, aexpr, k)`. ANF is already a linear sequence of
let-bindings ending in a tail expression, so it compiles almost directly to
straight-line async JS:
- functions/methods/lambdas → `async function`; the body opens with the arity
  check, `await R.checkPause()`, and per-argument annotation checks
  (`await R._checkAnn(...)`).
- calls (`a-app`/`a-method-app`) → `await f.app(...)` / `await R.maybeMethodCallN(...)`.
- prim-apps → `await R.f(...)` (always awaited: binops like `_plus`/`_lessthan`
  can dispatch to user methods and return a Promise; awaiting a non-Promise is
  identity).
- `a-if`/`a-cases` → JS `if`/`else` chains; the continuation `k` (always small:
  `return v` or a single `x = v`) is pushed into the branches, so the let-body
  after a bound `if`/`cases` is emitted exactly once.
- The whole `$step`/`switch`/`makeActivationRecord`/GAS-loop machinery is gone.
The value/data/annotation compilation (the bulk, including `a-data-expr`) is
reused verbatim from the trampoline visitor.

### 4. Async runtime (`runtime-async.js`)
A copy of `runtime.js` with only the control core reimplemented on Promises;
value representations, FFI, module loading (`runStandalone`) are unchanged
because they are built on these primitives:
- `checkPause()` — fuel meter; returns `undefined` synchronously while fuel
  remains, otherwise yields to the event loop (`setImmediate`) and honors a
  pending `breakAll()` by throwing `userBreak`. Preserves user interruption
  (e.g. a Stop button) without GAS/RUNGAS/Cont.
- `run()` — `await`s the program and reports Success/Failure via `onDone`;
  saves/restores fuel so nested runs (`run-task`, the checker) work, since the
  parent is genuinely suspended on a `pauseStack` Promise.
- `safeCall(fun, after)` — `async`: `return after(await fun())`. Everything built
  on `safeCall` (annotations `_checkAnn`/`checkAnnArgs`/`checkRefAnns`, predicate
  anns, method dispatch `maybeMethodCall*`, variant constructors) becomes
  async-correct for free: it returns the Promise and the compiled call site
  awaits it.
- `pauseStack(resumer)` — returns a Promise the restarter settles (resume →
  resolve, error → reject, break → reject `userBreak`). A paused Pyret stack IS
  a pending Promise; the compiled `await` suspends the JS stack until it settles.
  `execThunk`/`runStandalone`/native loading work unchanged on top of this.
- The hand-trampolined higher-order helpers that call user code were rewritten
  as plain async loops: `raw_array_*`/`raw_list_*` (map/fold/each/filter/build),
  the equality worklist (`equalHelp`, awaiting user `_equals`), and the `torepr`
  worklist (`toReprHelp`, awaiting user `_output`).
- `makeFlatPredAnn` is treated as non-flat: the flat `PPredAnn.check` fast path
  calls the predicate synchronously, but under async the predicate is an async
  function — so flat refinements route through the awaited path (otherwise the
  predicate would be silently skipped: a soundness hole). Genuinely-cheap
  `PPrimAnn`s (Number/String/brands) stay flat/sync.

### 5. Build wiring + cache discipline
- `standalone-configA-async.json` maps `pyret-base/js/runtime.js` →
  `build/phaseA/js/runtime-async.js`.
- New Makefile targets `%.async-jarr`, `pyret-test-async`, `all-pyret-test-async`,
  `test-clean-async`, and `new-bootstrap-async`, using the separate
  `tests/compiled-async/` cache.
- `new-bootstrap-async` builds the compiler with `-async-backend` via phaseA,
  then has that async-compiled compiler rebuild itself with `-async-backend`,
  and diffs: a clean diff (the async fixpoint) shows the async backend
  self-hosts byte-for-byte.

### 6. Polyglot / compiler-at-runtime
The hardest part. When an async-compiled program runs the compiler at runtime
(test-compile-lib, test-rec, run-to-result, the checker), the inner program runs
on an async runtime (this process, or a fresh `R.make-runtime()` — also async,
since the require-config maps the runtime). So nested compiles must use the
async backend AND resolve async-compiled builtins. Two mechanisms:
- `runtime-lib.js` exposes `is-async-backend()` (reads a marker on the async
  runtime).
- `compile-lib.arr` `compile-program-with` (the single chokepoint) calls
  `match-runtime-async-backend`: when the host runtime is async, it flips
  `async-backend` on for the nested options and retargets `compiled-cache` to a
  `-async` sibling.
- `cli-module-loader.arr` `async-cache-dir`: retargets the context's
  `cache-base-dir` (and read-only dirs) to the `-async` sibling, so the
  locators load async-compiled builtins instead of trampoline-compiled ones.
  (Without this, builtins like `render-error-display` loaded trampoline-compiled
  from `tests/compiled` and ran — and leaked — on the async runtime.)
- `string-dict.js` `eqHelp` (a shared JS trove) was hand-trampolined; rewritten
  via `runtime.safeCall` (a shared API that trampolines on sync and awaits on
  async) so the one file stays correct under both backends.

### 7. Environment prerequisite (orthogonal)
`require-node-dependencies.js`: guarded the eager `vega` require. Recent vega is
ESM-only and a synchronous `require()` of it aborts *every* standalone at load
under Node 18 (the runtime here), which blocked even the baseline suite. Charts
are unaffected for non-chart programs.

## Results

Measured on this VM (Node 18.19.1, headless — no browser/DOM).

| Target | Result |
| --- | --- |
| `make all-pyret-test` (default) | Passed 13357; Failed 0; Ended in Error 5 |
| `make all-pyret-test-async` | Passed 13342; Failed 12; Ended in Error 5 |
| `make new-bootstrap` (default) | phaseB == phaseC (byte-identical, 33192726 b); fixpoint holds |
| `make new-bootstrap-async` (new) | pyret-async-1 == pyret-async-2 (byte-identical, 26164872 b); async fixpoint |
| `test-compile-lib` (async, isolated) | 74/74 |
| `test-error-rendering` (async, isolated) | 58/58 |

- The **5 errored blocks are identical on both backends**: charts/images/world
  tests that need a DOM/browser, which this headless VM lacks. They error on the
  default backend too — the environment baseline, not a backend regression.
- The async backend has **0 correctness failures and 0 promise leaks**. The 12
  async-only failures are all in `test-repl.arr`'s one
  `L.get-result-stacktrace(...) is=~ [raw-array: ...]` block: it pins an exact
  trampoline frame list, and async frames are heap-allocated by V8, so the
  displayed frame list differs even though error *detection* is correct. This is
  the documented async stack-trace limitation (heap-allocated frames + extra
  `await` frames), not a correctness bug.

## Notes on `code.pyret.org` mocha
`npm run mocha` drives selenium/webdriver browser integration tests via
`heroku local`. This headless VM has no browser (same limitation as the charts
above), so those tests cannot run here on either backend. The runtime APIs the
IDE depends on (`safeCall`, `runThunk`, `execThunk`, `pauseStack`) are preserved
with the same external shapes by the async runtime, so the interface contract
the IDE relies on is intact.

---

# Optimizations (follow-on work)

Four changes on top of the async backend: tail-recursion (loop) optimization, an
await-avoidance micro-optimization on the fuel check, **flatness-based
non-async functions + await-free flat calls** (§4), and a stack-trace test
cleanup. All acceptance targets still hold: with all four optimizations `make
all-pyret-test-async` is **Passed 13367; Failed 0; Ended in Error 5** — an
*identical* count, with 0 failures, to `make all-pyret-test` on the default
backend (the 5 errors are the same DOM/browser environment errors on both
backends), and `make new-bootstrap-async` is a clean byte-for-byte fixpoint
(26654521 b — smaller than the pre-flatness 26702350 b, since flatness removes
async/await/fuel-check machinery from flat functions).

## 1. Tail-recursion (loop) optimization

The first cut of the async backend compiled every Pyret call — including a
self-recursive tail call — as `return await self.app(...)`: a fresh `async`
frame plus an `await` (a microtask round-trip) per iteration. A tight recursive
loop therefore allocated a continuation and bounced through the microtask queue
on every step.

`compile-fun-body` now detects self-recursive tail calls (`has-self-tail-call`,
using ANF's `is-recursive`/`is-tail` flags, matching arity) and, when TCO is
enabled, wraps the function body in `while (true) { ... }`. Such calls become a
back-edge — reassign the parameter variables (ordered by the ported
`get-assignments`, which uses temporaries only for a genuine cycle) and
`continue` — instead of a call. Generated shape:

```js
async function f(x_formal) {
  var al = <loc>;
  <arity-check>
  var x = x_formal;                 // copy formals once
  while (true) {
    if (R.needsPause()) { await R.pause(); }   // fuel check, every iteration
    await R._checkAnn(..., x);                  // arg anns, re-checked each iter
    ... body ...                                // tail self-call: x = ...; continue;
  }
}
```

The fuel check stays inside the loop so a tight recursive loop is still
interruptible (a Stop click is honored each iteration); argument annotations are
re-checked each iteration since the parameters are reassigned — matching
per-call semantics. `has-self-tail-call` decides this per function, so
non-recursive functions get no loop and no overhead. It stops at
lambda/method/data boundaries (those compile their own loops); methods are
excluded because `is-recursive` is false for them, matching the trampoline.

**Soundness guard (pyret issue #1230).** In-place mutation of a parameter is
unsound if the body builds a closure that captures that parameter and the
closure escapes (e.g. is passed to the tail call): a later iteration's mutation
would be observed through the escaped closure. `body-captures-params-in-lam`
(via `freevars-e`) detects any lambda whose free variables include a parameter
and leaves TCO off for that function, compiling its tail calls normally. This
reproduces the trampoline's behavior on the documented `oops2` case (both yield
4); `tests/pyret/regression/tail-recursion-arg-order.arr` passes under async.

## 2. await-avoidance micro-optimization

`checkPause()` was awaited at every function entry (`await R.checkPause()`).
Even when fuel remained and it returned `undefined`, the `await` forced a
microtask suspension. It is now split into a synchronous `needsPause()`
(decrement fuel, report whether exhausted) and an awaitable `pause()` (yield +
honor break), and the per-entry check is emitted as
`if (R.needsPause()) { await R.pause(); }` — so the common fuel-remaining path
pays for no `await` at all. `checkPause()` is kept as a compatibility wrapper.

## 3. Stack-trace test cleanup

Under async the Pyret stack is reconstructed from V8's async stack trace
(`exn-stack-parser.js`, via source maps over the compiled JS). V8 keeps a frame
only while its `await` has not yet suspended: a *synchronous* throw (e.g. a field
access or non-function application that raises before any awaited call) unwinds
with the full stack, but as soon as a frame executes an `await` that actually
suspends — an awaited prim-app/comparison, a fuel pause, an input/sleep pause —
the frames below it on the JS stack are gone. So in a deep recursion (each level
awaits a comparison) only the error frame survives, and the top-level call frame
is always lost (the run loop suspends at kickoff). What remains is always a
contiguous-from-the-error-site **subsequence** of the trampoline's full trace:
same frames, same order, no spurious entries, beginning at the true error
location. (Raising `Error.stackTraceLimit` does not help — it is already
`Infinity`; the limit is suspension, not depth.)

`tests/pyret/tests/test-repl.arr`'s stack-trace block pinned exact frame lists,
so 7 of its assertions failed under async. Per the instructions ("make the test
less specific … keep them meaningful"), those 7 are relaxed to the cross-backend
invariant above, via two small helpers added to the test file
(`subsequence-from-start`, `is-known-frame46`): each assertion still checks the
error frame is correct, the order is preserved, and no spurious frames appear —
and the trampoline trace (a subsequence of itself) still satisfies them exactly.
The other ~130 assertions are untouched. Both backends now pass test-repl
137/137. A more faithful fix (reconstructing the full logical stack by
accumulating frames on promise-rejection unwind) was rejected: it double-counts
against the JS-parsed synchronous frames, would re-break the assertions that
already pass under async, and adds a try/catch to every call — against the
backend's simplicity goal.

## 4. Flatness analysis: non-async flat functions + await-free flat calls

### Background — the existing flatness analysis
`flatness.arr` already computes, for every function, a *flatness*: `some(n)` if
the body contains at most `n` nested calls and **no** recursive call, method
call, or other non-flat call; `none` (infinite) otherwise. A function is
"flat-enough" when `n <= 5`. The analysis also folds in the flatness of the
function's argument/return annotations, and serializes each provided function's
flatness into the module's `provides` JSON (`"flatness": <n>|false`); the
hand-written builtin troves carry these annotations directly (e.g. `global.js`:
`num-abs`/`num-max`/`is-empty` are `flatness:0`, while `_plus`/`_lessthan` are
`flatness:false` because they can dispatch to user methods). The default
(trampoline) backend uses this in two places: a flat function's body skips the
activation-record/`GAS` machinery, and a *call* to a flat function skips the
`isContinuation` check (`compile-flat-app`).

### The two async-backend optimizations
The async analogue of "no activation record / no isCont check" is **non-async /
no await**:

1. **Flat functions are compiled as non-async JS functions.** `compile-a-lam`
   looks up the lambda's flatness by its binding name (threaded in via the new
   `opt-bind` parameter, exactly as the trampoline backend does) and, when
   flat-enough, emits `j-fun` instead of `j-fun-async`. Such a function also
   **skips the fuel check** entirely (it is bounded-depth and non-recursive, so
   it cannot spin — matching the trampoline omitting the `GAS` increment for flat
   functions), and is compiled in a new `flat-mode` in which its body emits no
   `await` at all.
2. **Calls to flat functions skip the `await`.** In `compile-expr-lettable`, a
   call whose callee is a safe id (`a-id`/`a-id-safe-letrec`) that is
   flat-enough (`is-callee-flat`) is emitted as a plain `f.app(...)` rather than
   `await f.app(...)` — the callee is non-async, so it returns a value, not a
   Promise. (Inside a flat function, `flat-mode` drops the await on *every* call,
   which the closure property below shows is sound.)

### Why this is sound
A flat function only ever calls other flat functions (a call to a non-flat
function would make it non-flat), never makes method/prim/non-flat-global calls
(those are `none`), and — because flatness includes annotation flatness — only
ever checks *flat* annotations. The decisive observation is that the runtime's
`_checkAnn` already returns **synchronously** (no Promise) for a flat annotation
— the same invariant the trampoline backend relies on when it omits the
`isContinuation` check after a flat `_checkAnn` (`compile-anns`). So a flat
function's argument/let annotation checks need no `await`, its calls need no
`await`, and it returns a value rather than a Promise — exactly what its
(unawaited) callers expect. Definition and call sites both decide via the same
`is-function-flat` lookup on the same shared `flatness-env`, so they never
disagree.

One runtime change makes the picture consistent: `makeFlatPredAnn` is restored
to set `flat=true` (the original async backend had forced it to `false`). With
the optimization a flat refinement predicate is a non-async function, so the
`PPredAnn.check` fast path can call `pred.app(val)` synchronously and treat the
boolean result directly — no Promise can leak. The compiler only emits
`makeFlatPredAnn` when the predicate is flat (so non-async), keeping this exact.

### Scope of the runtime win (and faithfulness to the trampoline)
The call-site await-avoidance fires precisely where the trampoline's
`compile-flat-app` fires: the callee must be a *safe* reference. Leaf flat
functions and flat builtin/library functions (referenced as plain globals, or
backward references inside a mutually-recursive group) qualify. Two independent
top-level `fun`s, however, land in *separate* letrec groups, so a call from one
to the other is an *unsafe* `a-id-letrec` reference — which both backends treat
as non-flat (the trampoline emits `compile-split-app`, the async backend keeps
the `await`). And a flat function can never share a letrec SCC with a caller
that calls it (that would be a cycle, making it non-flat). So at the
top-level-function granularity the *definition* win (leaf functions become
non-async, lose their fuel check and async state machine) is broadly available,
while the *call-site* win concentrates on calls into flat builtins/libraries and
within mutually-recursive groups — which is where the bulk of a real program's
flat calls live (the compiler self-host and the builtin troves; see the smaller
bootstrap output and the `bench-flat` timing below).

### Results
- `make all-pyret-test-async`: **Passed 13367; Failed 0; Ended in Error 5** —
  byte-for-byte the same pass/fail/error counts as `make all-pyret-test` on the
  default backend (verified by running both). 0 correctness failures and 0
  promise leaks across the whole suite.
- `make new-bootstrap-async`: clean byte-identical fixpoint at **26654521 b**,
  down from the pre-flatness **26702350 b** — direct evidence the optimization
  removed `async`/`await`/fuel-check machinery (≈48 KB) from flat functions and
  flat call sites across the self-hosted compiler.
- Codegen spot-check (`tests/async-opt/flat-sanity.arr`, a correctness test added
  for this work): leaf flat functions compile to non-async `function`s with no
  `needsPause`; flat refinement predicates pass via the `makeFlatPredAnn` fast
  path; behavior is identical to the trampoline.

## Timing

VM: Node 18.19.1, headless. Three configurations per row: **default** (the
unchanged trampoline backend), **async-noopt** (the async backend before this
work, commit `a32b194e`), **async-opt** (with the two optimizations).

### Microbenchmarks and individual test files (best-of-3 wall time, seconds)

Pure `node <standalone>` run time; the standalones are self-contained, so all
three configs were timed back-to-back under identical load.

| Workload | default | async-noopt | async-opt | opt vs noopt |
| --- | ---: | ---: | ---: | ---: |
| `bench-tco` — tight tail-recursive accumulator (40M tail iters) | 8.42 | 80.98 | 16.82 | **4.8× faster** |
| `bench-listsum` — tail-recursive list sum (×400 sweeps) | 6.37 | 37.37 | 10.50 | **3.6× faster** |
| `bench-nontail` — naive recursive `fib` (~25M non-tail calls) | 7.99 | 16.20 | 14.25 | 1.14× faster |
| `test-numbers.arr` (196 checks, arithmetic-heavy) | 0.79 | 35.43 | 35.46 | ~1.0× |
| `test-lists.arr` (list library) | 0.76 | 1.49 | 1.50 | ~1.0× |

(Benchmarks are in `tests/async-opt/`.) Reading: the loop optimization is a big
win where it applies — `bench-tco` and `bench-listsum` are tail-recursion-bound
and speed up 3.6–4.8×. `bench-nontail` cannot be TCO'd (the recursive call is not
in tail position), so only the fuel-check micro-opt applies: ~1.14×.
`test-numbers`/`test-lists` are dominated by per-operation awaits that neither
optimization removes, so they are ~neutral between noopt and opt. Against the
trampoline the async backend is still slower (the project's goal is simplicity,
not speed), but on recursion-heavy code the gap narrows to ~1.6–2×. The
`test-numbers` row (45× the trampoline, unchanged by these opts) shows where the
async backend's real remaining cost lives: every prim-app (`+`, `<`, …) is
unconditionally awaited, so arithmetic-heavy code pays a microtask per
operation. Making prim-app awaits conditional on the result actually being a
Promise is the obvious next optimization (it would also recover much of the lost
stack-trace fidelity), but it is a pervasive codegen change and out of scope
here.

### Flatness optimization (best-of-3 wall time, seconds)

Three configs, timed back-to-back under identical load: **default** (trampoline),
**async −flat** (the async backend *with* TCO + await-avoidance but *without* the
flatness optimization — i.e. the previous committed state), and **async +flat**
(this work). The standalones are self-contained; the −flat build was produced by
the pre-flatness compiler into an isolated builtin cache, the +flat build by the
current compiler.

| Workload | default | async −flat | async +flat | +flat vs −flat |
| --- | ---: | ---: | ---: | ---: |
| `bench-flat` — loop of 12 flat-builtin calls/iter (240M flat calls) | 20.72 | 40.87 | 25.72 | **1.59× faster** |
| `bench-tco` — tail-recursive accumulator (control) | 7.95 | 16.31 | 16.02 | ~1.0× |
| `bench-listsum` — tail-recursive list sum (control) | 5.50 | 9.89 | 10.00 | ~1.0× |

`bench-flat` (`tests/async-opt/bench-flat.arr`) is designed to isolate the
call-site win: each iteration calls 12 flat builtins (`num-modulo`/`num-abs`/
`num-max`/`num-min`, all `flatness:0`) referenced as plain globals — safe ids, so
the optimization emits them as bare `f.app(...)` instead of `await f.app(...)`.
Removing those 240M awaited microtasks cuts runtime **1.59×** (40.87 → 25.72 s),
closing most of the gap to the trampoline (the async backend goes from ~2.0× the
default down to ~1.24×). The verified codegen shows all 12 calls bare in the
+flat build and all 12 awaited in the −flat build. `bench-tco`/`bench-listsum`
are arithmetic/tail-recursion-bound with no flat calls in the hot path, and are
unchanged by flatness (within noise) — confirming no regression to the earlier
optimizations. (These rows' −flat column equals the earlier table's `async-opt`
column; the earlier `async-noopt` there means *before TCO*, a different
baseline.)

### `new-bootstrap` (clean two-stage self-host build, wall seconds)

| | default (`no-diff-standalone`, check-mode) | async-noopt | async-opt (−flat) | async +flat |
| --- | ---: | ---: | ---: | ---: |
| build + diff | 231.68 | 158.22 | 164.08 | 165.32 |
| stage output size (bytes) | — | — | 26702350 | 26654521 |

Bootstrap wall time is compilation/IO-dominated, so +flat is within noise of
−flat; but the +flat self-host output is **48 KB smaller** (and still a clean
byte-for-byte fixpoint), the concrete signal that flatness stripped async/await
and fuel-check machinery from the compiler's own flat functions and flat call
sites.

All the async configs are clean fixpoints (byte-identical stage outputs).
Bootstrap time is dominated by compilation/IO, not the optimized runtime paths,
so the async configs are within noise of each other; the opts target hot
user-code loops, not the compiler's compile-time throughput. (The async builds
use `-no-check-mode`, matching the existing `new-bootstrap-async` target; the
default two-stage build compiles check blocks, part of why it is slower.)

### Full test suite (`make all-pyret-test[-async]`, warm-cache run wall time)

Re-measured this session, default and async +flat back-to-back on the same warm
caches (so directly comparable). The historical `async-opt (−flat)` row is the
earlier measurement, kept for reference.

| Target | Wall (s) | Result |
| --- | ---: | --- |
| `make all-pyret-test` (default) | 678.68 | Passed 13367; Failed 0; Error 5 |
| `make all-pyret-test-async` (async +flat) | 639.33 | Passed 13367; Failed 0; Error 5 |
| `make all-pyret-test-async` (async-opt, −flat, earlier) | 767.67 | Passed 13361; Failed 0; Error 5 |

The pass/fail/error counts are **identical on the default and async +flat
backends** (13367 / 0 / 5), the strongest single correctness signal for the
optimization. (The count differs from the earlier −flat row's 13361 because of
unrelated drift in a few check blocks since that measurement; what matters is
that default and async now agree exactly, run for run.)

Two observations on the suite wall-times: (a) the full suite is dominated by
compilation and the compile-at-runtime tests (`test-compile-lib`, the repl), not
by tight numeric loops, so runtime optimizations move it only modestly — here
async +flat even edges ahead of the default (≈0.94×), comfortable parity at
suite level and far from the per-operation slowdowns seen on arithmetic
microbenchmarks; (b) flatness adds negligible compile-time cost (it reuses the
already-computed `flatness-env` and a cheap per-binding lookup), so it does not
reintroduce the compile-time overhead noted for the loop/closure analyses. The 5
`Ended in Error` blocks are the charts/images/world tests that need a DOM/browser
this headless VM lacks; they error identically on the default backend
(environment baseline, not a backend regression).

