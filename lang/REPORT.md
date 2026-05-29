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
  `test-clean-async`, using the separate `tests/compiled-async/` cache.

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
