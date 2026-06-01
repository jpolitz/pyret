# Resume: async-transform backend — checkpoint @ 7d6c1646f

Resume point for the async/promise compiler-backend work (spec: `async-transform.md`).
Branch: **`async-transform`**. This file is tagged with the short hash of the last
substantive commit at the time of writing; if you make another checkpoint, drop a new
`RESUME-<shorthash>.md`.

## Paste this as your first prompt in a fresh session (after `/clear`)

> Resume the async-transform compiler-backend work on branch `async-transform`. Read the
> project memory `async-transform.md` first, then `git log --oneline` and the spec
> `async-transform.md` in the repo root. Stages 0–1 (flag + dispatch + linkage + cache
> fork) are done and committed; continue with Stage 2 (async runtime core) + Stage 3
> (codegen rewrite), targeting `make sum.pjarr` running a recursive function. Verify
> file/line refs against current code before relying on them.

The persistent project memory (`async-transform.md`, auto-loaded each session) holds the
full 7-stage plan, the 3 design decisions, the Stage 2 runtime design, the Stage 3 codegen
insight, and the gotchas. This file is just a findable pointer.

## Status

**Done + committed (foundation, all validated):**
- `7d6c1646f` Stage 1: gitignore promise artifacts
- `faffd850d` Stage 1: async runtime linkage + `%.pjarr` rule + `compiled-promise/` cache fork
- `5a9d3b7b4` Stage 1: `js-of-pyret` dispatches codegen on `options.stack-backend`
- `9453ee0cd` Stage 1: verbatim copies of `anf-loop-compiler.arr` + `runtime.js`
- `5ab6687b3` Stage 0: inert `--stack-backend [promise|cont|auto]` flag plumbing

**Next (the core, one indivisible unit — runtime + codegen land together):**
- Stage 2: async runtime core in `src/js/base/runtime-async.js` — `needsPause`/`checkPause`
  (dual GAS+RUNGAS counters), async `run`/`topLoop`, async `safeCall`/`eachLoop`,
  `pauseStack`/`restarter`, sync-drain mode. Set `STACK_BACKEND = 'promise'`.
- Stage 3: straight-line async codegen in `src/arr/compiler/anf-loop-compiler-async.arr` —
  drop the split/`switch`/`Cont` trampoline; emit `async` bodies, `await f.app()` for
  non-flat calls, no-await for flat, `if(needsPause()) await checkPause()` at entry,
  explicit-loop TCO. Build a stack-depth regression test up front (the fast-path needs it).
- Milestone: `make sum.pjarr EF=' '` runs a recursive `sum`. Then Stage 4 (runtime breadth:
  `raw_array_*`, `toReprLoop`, `equal3`), Stage 5 (full suite + bootstrap, add
  `all-pyret-test-promise` / `new-bootstrap-promise` targets), Stage 6 (REPORT.md).

## Build/test cheatsheet
- **One-time:** `cd lang && npm install` (VM ships with empty `node_modules`; browserify needed).
- Compiler gate: `make phaseA` (~1–2 min). Promise single file: `make foo.pjarr EF=' '`.
- `EF=' '` is a literal space (keeps checks on; empty `EF` turns checks OFF).
- Run built jarrs from inside `lang/` (else `Cannot find module 'resolve'`).
- Value-taking CLI flags need DOUBLE dashes: `--stack-backend promise`.
- `make clean` often to dodge stale-cache/polyglot mixing (the spec's #1 time-sink).
- `npm run mocha` (code.pyret.org) is selenium → not runnable on this headless VM.
