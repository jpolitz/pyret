# Resume: async-transform backend — checkpoint @ c4020d171

Resume point for the async/promise compiler-backend work (spec: `async-transform.md`).
Branch: **`async-transform`**. This file is tagged with the short hash of the last
substantive commit; if you make another checkpoint, drop a new `RESUME-<shorthash>.md`.

## Paste this as your first prompt in a fresh session (after `/clear`)

> Resume the async-transform compiler-backend work on branch `async-transform`. Read the
> project memory `async-transform.md` first, then `git log --oneline` and the spec
> `async-transform.md` in the repo root. Stages 0–4 are DONE; Stage 5 (full suite) is well
> underway: the promise backend now reports check pass/fail and passes ~26 test files at parity
> with the cont backend (test-equality 6168/6168, test-strings 1125, test-array 637, …). The one
> remaining promise-specific gap is the NESTED-RUN cluster (test-contracts, test-error-rendering,
> test-include): `run-task`/checker + `run-str` compile-and-run a sub-program at runtime, which the
> async `runAsync` RUN_ACTIVE guard rejects. Continue by making nested/reentrant runs work in the
> async backend (or rewriting runWhileRunning/toReprArray to run inline), then re-run those files.
> The memory has the exact triage commands, the suite results, the flatness mental model, and the
> "shared trove .js trampoline → branch on runtime.stackBackend" pattern. Verify file/line refs
> against current code before relying on them.

The persistent project memory (`async-transform.md`, auto-loaded each session) has the full plan,
the codegen design, the flatness mental model (the crux), the runtime conversion list, and the
Stage-5 suite results + remaining gaps. This file is just a findable pointer.

## Status

**Done + committed:**
- `c4020d171` Stage 5: async string-dict equality (shared-trove `runtime.stackBackend` branch).
- `73a3c8b3b` Stage 5: check-result reporting (pauseStack→Promise) + tuple-bind error parity.
- `e16b10fe5` Stage 4: async safeCall/equal3/run-task + raw_array builders → clean error rendering.
- `e8edf57c5` Stage 4: async list/array helpers, async toRepr, two flatness-consistency compiler fixes.
- `940e592b8` Stage 2+3 milestone (sum(100000), 1M-deep TCO, tree-sum). Stage 0/1 scaffolding.

**Suite status (promise, -check-all): ~26 files PASS or at PARITY with cont.** Parity failures
(cont ALSO fails — don't chase): test-within 3, test-roughnum 1, test-pprint (both time out),
test-each-loop / test-include-block (both compile-error standalone). Promise-specific gap: the
nested-run cluster only (test-contracts, test-error-rendering, test-include 1).

**Triage command (run from `lang/`):**
```
node build/phaseA/pyret.jarr --outfile T.p.jarr --build-runnable tests/pyret/tests/T.arr \
  --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ --compiled-dir compiled-promise/ \
  --stack-backend promise -check-all --require-config src/scripts/standalone-configA-async.json
node T.p.jarr            # prints "Looks shipshape, all N tests passed" or a Passed/Failed summary
```
Cont equivalent: drop `--stack-backend promise`, use `--compiled-dir tests/compiled/` and
`--require-config src/scripts/standalone-configA.json`. Compare summary lines; parity = good.
(The plain `make T.p.jarr` rule does NOT pass `-check-all`, so it prints nothing for checks.)

**Next — finish Stage 5:** make nested/reentrant runs work in the async backend so `run-task`'s
compile-and-run path (run-str) works → unblocks test-contracts / test-error-rendering / test-include.
Then add `all-pyret-test-promise` + `new-bootstrap-promise` make targets, run the full suite. Stage 6: REPORT.md.

## Build/test cheatsheet
- **One-time:** `cd lang && npm install` (VM ships empty `node_modules`; browserify needed).
- Compiler gate: `make phaseA` (~1–2 min) after editing any compiler `.arr` (e.g.
  anf-loop-compiler-async.arr); COPY_JS also refreshes the runtime/trove js into build/phaseA.
- After editing ONLY a runtime/trove `.js`: `cp src/js/base/runtime-async.js build/phaseA/js/`
  (trove files are read from src directly), then `rm -rf compiled-promise` and rebuild.
- **`rm -rf compiled-promise` after ANY compiler/runtime change** — stale cached promise modules
  were the #1 red herring (an old module compiled before a fix looks like a live bug).
- Run built jarrs from inside `lang/` (node walks up for node_modules).
- `EF=' '` is a literal space (checks on; empty `EF` = checks OFF). CLI value flags need DOUBLE dashes.
- Shared trove `.js` files (string-dict.js, arrays.js, …) hold cont-style trampolines; for the async
  backend branch on `runtime.stackBackend === "promise"` and provide an `await` path (see eqHelp).
- To find a syntax error in a promise standalone, scan each module's `theModule` string with
  `new vm.Script("("+code+")")` — V8 reports `await`-in-sync-function as "Unexpected identifier".
- Parser traps: `check` is reserved; refinement anns need a NAMED predicate (`Number%(is-pos)`); a
  data variant `foo` auto-defines `is-foo` (don't also `fun is-foo`); ops trail line breaks.
