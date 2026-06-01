# Resume: async-transform backend — checkpoint @ 940e592b8

Resume point for the async/promise compiler-backend work (spec: `async-transform.md`).
Branch: **`async-transform`**. This file is tagged with the short hash of the last
substantive commit; if you make another checkpoint, drop a new `RESUME-<shorthash>.md`.

## Paste this as your first prompt in a fresh session (after `/clear`)

> Resume the async-transform compiler-backend work on branch `async-transform`. Read the
> project memory `async-transform.md` first, then `git log --oneline` and the spec
> `async-transform.md` in the repo root. Stages 0–3 are DONE and committed: the promise
> backend compiles and runs recursive `sum`, 1M-deep tail recursion (TCO), and data/`cases`
> programs (`make sum.p.jarr EF=' '` then `node sum.p.jarr`; regression test
> `lang/tests-promise/stack-depth.arr`). Continue with Stage 4: broaden runtime breadth so
> larger programs run — start by running existing test files under the promise backend to
> find the first gaps. Verify file/line refs against current code before relying on them.

The persistent project memory (`async-transform.md`, auto-loaded each session) has the full
plan, the completion-passing codegen design, the Stage 2 runtime design, and the parser
gotchas. This file is just a findable pointer.

## Status

**Done + committed (validated end-to-end):**
- `940e592b8` Stage 2+3: async runtime core + straight-line async codegen. MILESTONE: promise
  backend runs `sum(100000)`→5000050000, 1,000,000-deep tail recursion (TCO loop), and a
  data/`cases` tree-sum. Cont backend unaffected (`make sum.jarr` still works).
- Stage 0/1 commits (flag, verbatim copies, dispatch, linkage, cache fork, `%.p.jarr` rule).

**What works now under `--stack-backend promise`:** recursion (non-tail via await/fuel stack
unwinding; tail via explicit `while(true)` TCO loop), `if`, `cases`/data + constructors,
number arithmetic + `==`, `print`, module load. See memory for the codegen + runtime design.

**Next — Stage 4 (runtime breadth):** the happy path (numbers/if/app/cases) works because of
sync fast-paths; broaden so real programs run. Likely first gaps: `_checkAnn` w/ refinements,
`equal3`/`toReprLoop`/`equal-now`, `eachLoop` (still old trampoline), method calls
(`maybeMethodCallN` must await async methods), `raw_array_*`. Strategy: pick an existing test
file, `make <it>.p.jarr EF=' '`, run, fix the first failure, repeat. Then Stage 5: add
`all-pyret-test-promise` + `new-bootstrap-promise` make targets, run the full suite, triage
(async stack traces differ — flag/defer pinned-stacktrace tests, don't chase them). Stage 6:
REPORT.md.

## Build/test cheatsheet
- **One-time:** `cd lang && npm install` (VM ships empty `node_modules`; browserify needed).
- Compiler gate: `make phaseA` (~1–2 min, rebuilds compiler from the `.arr` sources).
- After editing ONLY a runtime `.js`: `cp src/js/base/runtime-async.js build/phaseA/js/` then
  `rm -f foo.p.jarr && make foo.p.jarr` (the `%.p.jarr` rule doesn't depend on the runtime js).
- Promise single file: `make foo.p.jarr EF=' '`, then **`node foo.p.jarr` from inside `lang/`**
  to actually RUN it (the rule only builds). Cont equivalent: `make foo.jarr EF=' '`.
- `EF=' '` is a literal space (keeps checks on; empty `EF` turns checks OFF).
- Value-taking CLI flags need DOUBLE dashes: `--stack-backend promise`.
- `make clean` often to dodge stale-cache/polyglot mixing (the spec's #1 time-sink).
- Capture long output to files; `npm run mocha` is selenium → not runnable on this headless VM.
- Pyret parser traps (cost real time, see memory): `check` is reserved; ops trail line breaks;
  top-level `x = value` splits the letrec group (use `fun`, order defs after their deps).
