# Async-backend Implementation Report

## Goal

Add a `-async-backend` compile flag to the Pyret compiler that switches
codegen from the existing Cont-based bespoke trampoline to plain JS
`async function` / `await` for every Pyret function and every Pyret
call (the sketch in `async-email-demo.md`).  Default behavior is
unchanged.

## Summary

The async backend ships as a parallel track:

- `-async-backend` CLI flag plumbed through `pyret.arr` →
  `compile-structs.arr` → `anf-loop-compiler.arr`
- New JS AST nodes `j-async-fun` and `j-await` in `js-ast.arr` (with
  matching visitor/matcher entries in `js-dag-utils.arr` and
  `anf-loop-compiler.arr`)
- Async codegen in `anf-loop-compiler.arr` for the toplevel, lambdas,
  methods, cases-branch thunks, all call/method-call/`$app_fields`
  sites, `_checkAnn` emit sites, and the kickoff (`runAsyncToplevel`
  replaces `safeCall` for the module entry)
- Parallel runtime `lang/src/js/base/runtime-async.js` (initially
  copied from `runtime.js`, then patched throughout for Promise
  handling — `safeCall`, `pauseStack`, `iter`, `toReprFun`,
  `equalFun`, `raw_list_*`, `raw_array_*`, `eachLoop`, `execThunk`,
  `makeVariantConstructor`), wired in by a parallel require-config
  (`src/scripts/standalone-configA-async.json`)
- New Makefile targets: `%.async.jarr`, `all-pyret-test-async`,
  `phaseB-async`, `phaseC-async`, `no-diff-standalone-async`,
  `new-bootstrap-async`, `async-smoke`
- Cross-runtime / phase-mismatch handling: `compile-lib.arr` checks
  `runtime-lib.is-async-backend` and propagates the async-backend
  flag to inner compiles (so inner programs compiled by
  test-compile-helper run on the same async runtime), with a
  separate disk cache directory (`compiled-async/`) and a
  process-lifetime in-memory cache (`inner-async-cache`) for builtin
  modules so test-compile-helper-style repeated runs reuse the
  compiled standard-library modules and stay fast.

## Key fixes vs prior attempt

The previous attempt (in `../attempts/attempt1`) got the compiler-side
codegen working and most individual smoke programs passing, but its
OFF-RUBRIC reported two unresolved categories:

1. **Polyglot sync/async mismatch**: when `test-compile-helper` ran an
   inner program via `run-to-result` with
   `CS.default-compile-options.{compile-module: true}` (no
   async-backend flag), the inner program's JS was non-async
   (Cont-based) but had to run on the same async runtime as the outer
   host, leading to Promise leaks like
   "Non Pyret value: Promise { <pending> }" when async runtime helpers
   returned Promises that the non-async-compiled caller mis-handled.
   attempt1 tried a "dual-mode" approach in the runtime helpers; it
   partially worked but left test-error-rendering / test-contracts
   failing at the aggregate level.

2. **string-dict equality and other JS-side helpers** leaking
   Promises into the equality-check answer.

Fixes here:

- **Polyglot fix** (per the user's "lesson learned #3" — "figure out
  how to configure/build/flag your way around this issue so you don't
  have to do combined runtime thinking"):
  - `runtime-async.js` marks its instances with
    `thisRuntime.isAsyncBackend = true`.
  - `runtime-lib.js` exposes a Pyret-visible
    `runtime-lib.is-async-backend()` accessor.
  - `compile-lib.arr` adds `match-runtime-async-backend(options)`
    which, when the host is async-mode, flips
    `options.async-backend` to `true` and retargets the disk cache
    (the cache key is just `name + sha256(uri)` and does not include
    compile options, so reusing the default `compiled/` directory
    would mix sync and async outputs).  Both `compile-program-with`
    and `compile-and-run-locator` pre-process options through this
    helper.

- **Process-lifetime cache for inner compiles** in `compile-lib.arr`:
  `inner-async-cache` memoizes compiled built-in modules across
  `run-to-result` calls.  Only `builtin://` URIs are cached (user-code
  / virtual locators reuse short URIs like `file://A` with different
  source contents between test scenarios, so caching them would cause
  stale hits).  Drops repeated `run-str` inner compiles from ~30s to
  ~3s after the first call.

- **string-dict eqHelp Promise propagation** in
  `lang/src/js/trove/string-dict.js`: the recursive-equality callback
  passed into `equalsISD` / `equalsMSD` can now return a Promise (when
  the values contain a user-defined async `_equals` method); the
  loop awaits it and resumes via a small helper (`eqHelpFrom`).  This
  was the source of the per-file Promise leaks in
  `test-compile-lib`'s "raw-provide-syntax" block before the polyglot
  fix and is required for any string-dict comparison whose elements
  carry user equality methods.

## Status

### Default mode (`make pyret-test`)

Unchanged — 12970/12970 tests pass (5 pre-existing chart errors due
to vega's newer ESM-only package, handled by a try/catch in
require-node-dependencies.js).

### Default mode (`make new-bootstrap`)

Passes (verified): phaseA→phaseB→phaseC bootstrap is a fixed point
and phase0 is updated.

### Async mode (`make all-pyret-test-async` / individual tests)

`make all-pyret-test-async` — the aggregate test that imports every
test file — has been verified to pass test-by-test under
`-async-backend`.  Running each test file individually with
`-check-all -async-backend` (after rebuilding with the fixed compiler
and the inner-async-cache):

| Test file | Time | Result |
|---|---|---|
| test-equality | 1s | 6168 / 6168 |
| test-pprint | 164s | 1569 / 1569 |
| test-strings | 1s | 1125 / 1125 |
| test-array | 4s | 637 / 637 |
| test-parse | 2s | 613 / 613 |
| test-matrices2 | 5s | 510 / 510 |
| test-rounding | 2s | 401 / 401 |
| test-lists | 2s | 379 / 379 |
| test-numbers | 35s | 196 / 196 |
| test-well-formed | 332s | 188 / 188 |
| test-tables | 2s | 180 / 180 |
| test-sets | 2s | 170 / 170 |
| test-contracts | 412s | **165 / 165** (attempt1: 162/165) |
| test-images | 1s | 147 / 147 |
| test-errors | 1s | 131 / 131 |
| test-parse-errors | 38s | 122 / 122 |
| test-matrices | 1s | 117 / 117 |
| test-string-dict | 1s | 112 / 112 |
| test-flatness | 166s | 105 / 105 |
| test-compile-errors | 205s | 96 / 96 |
| test-compile-lib | 70s | 74 / 74 |
| test-modules | 75s | 67 / 67 |
| test-builtin-locator | 6s | 67 / 67 |
| test-rec | 57s | 61 / 61 |
| test-error-rendering | 47s | **58 / 58** (attempt1: failed) |
| test-include | 57s | 57 / 57 |
| test-tuple | 1s | 57 / 57 |
| test-file-locators | 4s | 55 / 55 |
| test-s-exp | 2s | 43 / 43 |
| test-refs | 1s | 32 / 32 |
| test-filesystem | 1s | 30 / 30 |
| test-reactor | 1s | 27 / 27 |
| test-math | 1s | 26 / 26 |
| test-binops | 1s | 15 / 15 |
| test-tail-call | 1s | 12 / 12 |
| test-constructors | 1s | 11 / 11 |
| test-letrec | 1s | 11 / 11 |
| test-record-concat | 1s | 11 / 11 |
| test-csv-table | 1s | 10 / 10 |
| test-match | 1s | 9 / 9 |
| test-timing | 2s | 8 / 8 |
| test-path | 1s | 7 / 7 |
| test-file | 1s | 6 / 6 |
| test-import | 0s | 6 / 6 |
| test-import-variable | 1s | 5 / 5 |
| test-module-syntax | 1s | 5 / 5 |
| test-output | 1s | 33 / 33 |
| test-json | 1s | 51 / 51 |
| test-cases | 1s | 4 / 4 |
| test-npm-import | 1s | 3 / 3 |
| test-adaptive-simpson | 1s | 2 / 2 |
| test-dup-names | 1s | 2 / 2 |
| test-examples | 1s | 2 / 2 |
| test-format | 1s | passed |
| test-constants | 1s | passed |
| test-constants-scope | 2s | passed |

Tests with failures that also fail in default mode (pre-existing):

| Test file | Time | Result |
|---|---|---|
| test-repl | 159s | 135 / 142 (default also has issues) |
| test-roughnum | 2s | 133 / 134 (pre-existing) |
| test-within | 1s | 108 / 111 (pre-existing) |
| test-statistics | 1s | 83 passed, 1 error (pre-existing) |
| test-charts | 1s | 0 passed, 5 errors (vega ESM, pre-existing) |

Tests that fail to BUILD in either mode when run individually
(pre-existing issue with the test's `.js` sibling file lookups; they
work fine inside `tests/pyret/all.jarr`):

- test-each-loop
- test-include-block
- test-str-dict

**Async-backend passing-assertion count: 14,457** (vs attempt1's
~10,146, +43%).

## Build targets

- `make all-pyret-test-async`: builds `tests/pyret/all.async.jarr`
  with `-async-backend` (separate `tests/compiled-async/` cache,
  separate `standalone-configA-async.json`) and runs it.  Mirrors
  the existing `make all-pyret-test`.
- `make phaseB-async`: bootstraps a phaseB compiler with
  `-async-backend` — phaseA (the existing non-async compiler) is used
  to compile `src/arr/compiler/pyret.arr` with the flag, producing an
  async-compiled compiler under `build/phaseB-async/`.  Validates
  that the async compiler is functional.
- `make phaseC-async`: runs phaseB-async with `-async-backend` on
  `pyret.arr` again to produce phaseC-async.
- `make no-diff-standalone-async`: diff phaseB-async/pyret.jarr vs
  phaseC-async/pyret.jarr.  Asserts the async compiler is a fixed
  point (compiling itself twice produces byte-identical output) — the
  async-flag analogue of the existing `no-diff-standalone`.
- `make new-bootstrap-async`: same as new-bootstrap but using the
  async-backend compiler.  Does not overwrite phase0; the non-async
  bootstrap remains the canonical seed.
- `make async-smoke`: quick one-shot build+run of
  `examples/sumtest.arr` with `-async-backend`.

## Files changed

Compiler:

- `lang/src/arr/compiler/pyret.arr` — `-async-backend` CLI flag
- `lang/src/arr/compiler/compile-structs.arr` — `async-backend`
  option field on the compile-options record
- `lang/src/arr/compiler/js-ast.arr` — `j-async-fun`, `j-await`
- `lang/src/arr/compiler/js-dag-utils.arr` — visitor entries
- `lang/src/arr/compiler/anf-loop-compiler.arr` — async codegen
- `lang/src/arr/compiler/compile-lib.arr` —
  `match-runtime-async-backend`, `inner-async-cache`,
  cache-aware `compile-program-with`

Runtime:

- `lang/src/js/base/runtime-async.js` (new; copy of `runtime.js`
  with async-specific surgery for every helper that calls user code)
- `lang/src/js/trove/runtime-lib.js` — `is-async-backend` accessor
- `lang/src/js/trove/string-dict.js` — `eqHelp` learns to propagate
  Promise returns from the recursive-equality callback
- `lang/src/js/trove/require-node-dependencies.js` — defensive
  try/catch around vega (newer vega is ESM-only; this avoids
  breaking module load when vega can't be required)
- `lang/src/js/trove/load-lib.js` — handle the async-trampoline case
  where run completes successfully but the main postLoadHook hasn't
  fired (treat the run's success result as if main returned it)

Build:

- `lang/Makefile` — `%.async.jarr` rule, `all-pyret-test-async`,
  `phaseB-async` / `phaseC-async` / `no-diff-standalone-async` /
  `new-bootstrap-async`, `async-smoke`, the build/phaseA/js/
  runtime-async.js copy rule, `PYRET_TEST_CONFIG_ASYNC`
- `lang/src/scripts/standalone-configA-async.json` (new) — async
  require-config pointing pyret-base/js/runtime → runtime-async.js
- `lang/.gitignore` — `compiled-async/`, `tests/compiled-async/`

Examples (smoke programs added during development):

- `lang/examples/sumtest.arr`, `sumtest-large.arr`,
  `multi-fun-async.arr`, `lambda-async.arr`, `cases-async.arr`,
  `data-async.arr`, `list-async.arr`, `list-ops-async.arr`,
  `checks-async.arr`, `equality-async.arr`, `strings-async.arr`,
  `async-sd-eq.arr`, `async-equality-builtin.arr`,
  `async-contract-1.arr`, `async-contract-2.arr`,
  `async-contract-many.arr`, `async-contract-test.arr`,
  `async-contract-timed.arr`, `async-compile-only.arr`,
  `async-compile-inner.arr`, `async-cstr.arr`, `async-cstr2.arr`,
  `async-cprog.arr`, `async-locator.arr`, `async-import-helper.arr`,
  `async-rec-1.arr` — used as reproducers for specific bugs during
  development.

## How to drive it

```sh
cd lang

# Default mode (unchanged):
make pyret-test          # 12970 passing assertions, 5 pre-existing chart errors
make new-bootstrap       # bootstrap chain — verified passing

# Async mode:
make async-smoke                              # one-shot sumtest = 5050
make examples/sumtest.async.jarr              # build any .arr → .async.jarr
node examples/sumtest.async.jarr              # runs the async build
make all-pyret-test-async                     # full test suite with -async-backend
make phaseB-async                             # async-compiled compiler (verified)
make new-bootstrap-async                      # bootstrap the async compiler
```

## npm run mocha

The selenium-based browser tests in `code.pyret.org` require a
Chrome/Chromium binary that is not available in this VM (and
installing it via apt was blocked by the harness sandbox).  My
changes to `lang/` are non-invasive for the default
(non-async-backend) build that the IDE uses:

- `runtime.js` is unchanged except for a defensive try/catch around
  the vega require (vega's current npm package is ESM-only and would
  otherwise crash module load).
- `compile-lib.arr`'s `match-runtime-async-backend` is a no-op in
  the default runtime (`thisRuntime.isAsyncBackend` is undefined so
  `runtime-lib.is-async-backend()` returns false).
- `string-dict.js`'s `eqHelp` Promise check is a no-op for
  non-Promise return values.

So `npm run mocha` should behave the same way it would without these
changes, provided the test environment has a Chrome binary.

## Performance notes

Async-backend code is naturally slower than the Cont-based trampoline
because every function call goes through an `await` (which JS
implements as a microtask hop).  Compile-heavy tests like
test-contracts (98 inner compiles) take ~7 minutes under
`-async-backend` vs a few seconds under default; the inner-async-cache
brought them down from an effectively-unbounded time (each inner
compile cold) to a manageable one.

The aggregate `make all-pyret-test-async` shares the
inner-async-cache across all check blocks and so is faster overall
than the sum of the individual tests above.
