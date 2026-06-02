# Resume: async-transform backend — checkpoint @ 42e9fe860

Resume point for the async/promise compiler-backend work (spec: `async-transform.md`).
Branch: **`async-transform`**. This file is tagged with the short hash of the last
substantive commit; if you make another checkpoint, drop a new `RESUME-<shorthash>.md`.

## Paste this as your first prompt in a fresh session (after `/clear`)

> Resume the async-transform compiler-backend work on branch `async-transform`. Read the
> project memory `async-transform.md` first, then `git log --oneline` and the spec
> `async-transform.md` in the repo root. Stages 0–4 are DONE; Stage 5 is nearly done: the
> promise backend now passes the full per-file suite at parity with cont, INCLUDING the
> former nested-run cluster (test-contracts 165/165, test-error-rendering 58/58, test-include
> 57/57). What's LEFT in Stage 5: add `all-pyret-test-promise` + `new-bootstrap-promise` make
> targets and run the whole suite in one go; then Stage 6 = REPORT.md. The memory has the
> exact triage commands, the flatness mental model, the suite results, and the two root
> causes just fixed (polyglot cache mixing + missing arg-ann checks). Verify file/line refs
> against current code before relying on them.

The persistent project memory (`async-transform.md`, auto-loaded each session) has the full
plan, codegen design, flatness mental model, runtime conversion list, and Stage-5 results.
This file is just a findable pointer.

## Status

**Done + committed:**
- `42e9fe860` Stage 5: nested-run cluster — backend-aware builtin cache + arg-ann checks.
- `c4020d171` Stage 5: async string-dict equality (shared-trove `runtime.stackBackend` branch).
- `73a3c8b3b` Stage 5: check-result reporting (pauseStack→Promise) + tuple-bind error parity.
- `e16b10fe5` Stage 4: async safeCall/equal3/run-task + raw_array builders → clean error rendering.
- `e8edf57c5` Stage 4: async list/array helpers, async toRepr, two flatness-consistency compiler fixes.
- `940e592b8` Stage 2+3 milestone (sum(100000), 1M-deep TCO, tree-sum). Stage 0/1 scaffolding.

**Suite status (promise, -check-all): full per-file parity with cont.** The nested-run cluster
(test-contracts / test-error-rendering / test-include) now PASSES — it was the last
promise-specific gap. Known parity failures (cont ALSO fails — don't chase): test-within 3,
test-roughnum 1, test-pprint (both time out), test-each-loop / test-include-block (both
compile-error standalone).

**The two root causes fixed in 42e9fe860 (both were "Non Pyret value: Promise" leaks):**
1. **Polyglot cache mixing** — nested compile-and-run (`run-task`/`run-str` via
   `compile-and-run-locator`) loaded builtins from the CONT cache dirs even on the promise
   host. Cont- and promise-compiled modules share a SOURCE-only hash but emit incompatible JS,
   so the loader silently ran cont-compiled `lists`/`render-error-display` (sync trampoline,
   no `await f.app`) on the async runtime → Promise leaked into `_checkAnn`. Fix:
   `default-compile-options.compiled-cache` (compile-structs.arr) + `default-{start,test}-context`
   cache dirs (cli-module-loader.arr) resolve to `./compiled-promise` when
   `compiled-stack-backend` is promise. Resolution happens at RUNTIME inside the standalone
   from its linked runtime, so cont is untouched.
2. **Missing arg-ann contracts** — `compile-fun-body` (anf-loop-compiler-async.arr) never
   emitted argument annotation checks, so `fun f(x :: Number): x end \n f("foo")` ran clean.
   Added `ann-check-stmts` per formal at the top of the loop body (re-checks on each TCO
   re-entry, matching cont's step=0 reset).

**Debugging method that cracked it:** the leak is always a `_checkAnn` getting a `Promise`.
Temporarily add to runtime-async.js `_checkAnn`: `if (val && typeof val.then==="function")
CONSOLE.error("LEAK", JSON.stringify(compilerLoc), ann && ann.name)` — `compilerLoc` is a
`["builtin://MOD", line, col, ...]` srcloc that names the exact module+line. That pointed
straight at `lists.arr:475` (filter's return ann) → revealed cont-compiled lists was running.

**Triage command (run from `lang/`):**
```
node build/phaseA/pyret.jarr --outfile T.p.jarr --build-runnable tests/pyret/tests/T.arr \
  --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ --compiled-dir compiled-promise/ \
  --stack-backend promise -check-all --require-config src/scripts/standalone-configA-async.json
node T.p.jarr            # prints "Looks shipshape, all N tests passed" or a Passed/Failed summary
```
Cont equivalent: drop `--stack-backend promise`, use `--compiled-dir tests/compiled/` and
`--require-config src/scripts/standalone-configA.json`. Compare summary lines; parity = good.

**Next — finish Stage 5:** add `all-pyret-test-promise` + `new-bootstrap-promise` make targets
(deferred since Stage 1), run the full suite end-to-end on the promise backend. Then Stage 6:
REPORT.md. The mocha tests are selenium → unrunnable on this headless VM.

## Build/test cheatsheet
- **One-time:** `cd lang && npm install` (VM ships empty `node_modules`; browserify needed).
- Compiler gate: `make phaseA` (~1–2 min) after editing any compiler `.arr` (e.g.
  anf-loop-compiler-async.arr, compile-structs.arr, cli-module-loader.arr); COPY_JS also
  refreshes the runtime/trove js into build/phaseA.
- After editing ONLY a runtime/trove `.js`: `cp src/js/base/runtime-async.js build/phaseA/js/`
  (trove files are read from src directly), then `rm -rf compiled-promise` and rebuild.
- **`rm -rf compiled-promise` after ANY compiler/runtime change** — stale cached promise modules
  were the #1 red herring (an old module compiled before a fix looks like a live bug).
- Run built jarrs from inside `lang/` (node walks up for node_modules).
- `EF=' '` is a literal space (checks on; empty `EF` = checks OFF). CLI value flags need DOUBLE dashes.
- **Cache dirs are backend-keyed:** promise builtins live in `compiled-promise/`, cont in
  `compiled/` and `tests/compiled/`. Same source hash, different content — never cross them.
- Shared trove `.js` files (string-dict.js, arrays.js, load-lib.js, …) hold cont-style
  trampolines; for the async backend branch on `runtime.stackBackend === "promise"` and
  provide an `await` path. (load-lib's renderErrorMessage/renderCheckResults/runProgram use
  pauseStack+runThunk and worked unmodified once the cache mismatch was fixed.)
- To find a syntax error in a promise standalone, scan each module's `theModule` string with
  `new vm.Script("("+code+")")` — V8 reports `await`-in-sync-function as "Unexpected identifier".
- Parser traps: `check` is reserved; refinement anns need a NAMED predicate (`Number%(is-pos)`); a
  data variant `foo` auto-defines `is-foo` (don't also `fun is-foo`); ops trail line breaks.
