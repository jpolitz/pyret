# Resume: async-transform backend — checkpoint @ e16b10fe5

Resume point for the async/promise compiler-backend work (spec: `async-transform.md`).
Branch: **`async-transform`**. This file is tagged with the short hash of the last
substantive commit; if you make another checkpoint, drop a new `RESUME-<shorthash>.md`.

## Paste this as your first prompt in a fresh session (after `/clear`)

> Resume the async-transform compiler-backend work on branch `async-transform`. Read the
> project memory `async-transform.md` first, then `git log --oneline` and the spec
> `async-transform.md` in the repo root. Stages 0–4 are DONE and committed: the promise
> backend runs a wide variety of real programs (lists map/filter/fold/each/sort, data/cases,
> tuples, for-loops, strings, numbers, sets, options, string-dict, `==` incl. user `_equals`,
> raise/run-task, data field refinement anns) and renders errors cleanly, matching the cont
> backend. Build+run: `make foo.p.jarr EF=' '` then `node foo.p.jarr` from inside `lang/`.
> Continue with Stage 5: add `all-pyret-test-promise` + `new-bootstrap-promise` make targets and
> run the full suite. The memory lists the KNOWN async gaps Stage 5 will hit first (the
> pauseStack-based check-result reporting hook in handalone.js, toReprArray/spy, runWhileRunning,
> data-field non-flat refinements). Verify file/line refs against current code before relying on them.

The persistent project memory (`async-transform.md`, auto-loaded each session) has the full
plan, the codegen design, the flatness mental model (the crux of Stage 4), and the runtime
conversion list. This file is just a findable pointer.

## Status

**Done + committed (validated end-to-end):**
- `e16b10fe5` Stage 4 (part 2): async safeCall/equal3/run-task + raw_array builders → clean error
  rendering. `e8edf57c5` Stage 4 (part 1): async list/array helpers, async toRepr, the two
  flatness-consistency compiler fixes.
- `940e592b8` Stage 2+3 milestone (sum(100000)=5000050000, 1M-deep TCO, tree-sum via cases).
- Stage 0/1 commits (flag, copies, dispatch, linkage, cache fork, `%.p.jarr` rule).

**What works now under `--stack-backend promise`:** everything from the milestone PLUS lists
(map/filter/fold/each/sort/range/foldr), data + `cases` + constructors (incl. flat refinement field
anns), `==` on data values (user `_equals`) and lists, tuples, for-loops, sets, options, string-dict,
string/number builtins, `raise`/`run-task`, and CLEAN error rendering (lookup-non-object, type
mismatch, raise, predicate failure). 9 real suite test files build + run without runtime crash. See
memory for the codegen + runtime design and the flatness mental model.

**Next — Stage 5 (full suite + bootstrap):** add `all-pyret-test-promise` + `new-bootstrap-promise`
make targets, run the suite, triage. The memory's Stage 5 TODO lists the known async gaps to hit
first: (a) check-result reporting is silent (handalone.js postLoadHook[main] uses `pauseStack(resumer)`
whose resumer never fires in the async backend); (b) `toReprArray`/spy + `runWhileRunning` still use
the pauseStack+runThunk idiom; (c) `makeDataTypeConstructor` sync `_checkAnn` would leak on a NON-flat
data-field refinement; (d) async stack traces differ — flag/defer pinned-stacktrace tests. Stage 6: REPORT.md.

## Build/test cheatsheet
- **One-time:** `cd lang && npm install` (VM ships empty `node_modules`; browserify needed).
- Compiler gate: `make phaseA` (~1–2 min, rebuilds compiler from the `.arr` sources). Needed after
  editing any compiler `.arr` (e.g. anf-loop-compiler-async.arr); COPY_JS also refreshes the runtime js.
- After editing ONLY a runtime `.js`: `cp src/js/base/runtime-async.js build/phaseA/js/` then
  `rm -rf compiled-promise && rm -f foo.p.jarr && make foo.p.jarr EF=' '`.
- **`make clean` / `rm -rf compiled-promise` after ANY compiler change** — stale cached promise
  modules were the #1 red herring this stage (an old lists.arr compiled before a fix looks like a live bug).
- Promise single file: `make foo.p.jarr EF=' '`, then **`node foo.p.jarr` from inside `lang/`**.
  Cont equivalent: `make foo.jarr EF=' '` (regression-check the cont backend stays green).
- `EF=' '` is a literal space (keeps checks on; empty `EF` turns checks OFF). Value-taking CLI flags
  need DOUBLE dashes: `--stack-backend promise`.
- Single-file standalone does NOT print check pass/fail on EITHER backend (Stage 5 harness needed).
- To find a syntax error in a promise standalone, scan each module's `theModule` string with
  `new vm.Script("("+code+")")` — V8 reports `await`-in-sync-function as "Unexpected identifier".
- Pyret parser traps (cost real time, see memory): `check` is reserved; refinement anns need a NAMED
  predicate (`Number%(is-pos)`, not an inline `lam`); a data variant `foo` auto-defines `is-foo`
  (don't also `fun is-foo`); ops trail line breaks; top-level `x = value` splits the letrec group.
