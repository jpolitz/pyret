# Goal: port the Promise/async backend onto the TypeScript compiler

## Background — two orthogonal efforts to be joined

1. **The TS compiler** (`lang/src/ts-compiler/`) is a clean-room TypeScript
   port of Pyret's compiler. It produces output **byte-identical** to the Pyret
   cont compiler (the determinism work on this branch: commits
   `0dac9c0f5`/`e5123eedf`), and is browser-ready (code.pyret.org/ uses it)

2. **The Promise backend** (originally built in the sibling `../pyret-async` checkout,
   now grafted into this tree by Phase 0) is a **second** Pyret compiler backend that
   compiles every function to a JS `async function`, awaits at each call site, and takes
   fuel via `await checkPause()`. It is selected by `--stack-backend promise`, links
   `runtime-async.js`, and is **safe-for-space** for cross-function tail recursion via a
   bounce-token + driver. See `../pyret-async/REPORT.md`.

The two are conceptually orthogonal: they meet only at:
  - the single codegen dispatch point in `js-of-pyret`, and
  - the **flatness** verdicts that every await/async decision keys off.

The Promise **runtime** is plain JS, as with all of Pyret's runtime backend
(linked via `--require-config`), so it does **not** get ported to TypeScript —
only the compiler-side codegen is.

## Why do this

TS port is 4.7×–30× compile speed and a dramatically smaller network footprint.
The Promise backend's is performance-similar to cont, is dramatically simpler,
makes generated Pyret code smaller, and provides a more legible interface for
JS programmers (call with `await`, rather than understanding Pyret's whole
stack-management API). They complement each other well.

## What Phase 0 already established (the oracle prerequisite)

The byte-parity oracle requires a **canonical** Pyret-promise reference. `../pyret-async`
predates the determinism work and cannot provide one. Phase 0 therefore grafted the
Promise backend into *this* (canonical) tree and mirrored the determinism sorting into
the async ANF compiler. Result, all verified:

- The cont path is unchanged (phaseA rebuilds clean; cont compile+run byte-for-byte as before).
- The Promise backend compiles + runs in-tree on `runtime-async.js` (output identical to cont).
- Promise compilation is **reproducible**: two independent cold builds are byte-identical
  (0 differing cache files, identical standalone jarrs), across all 30 rich builtin modules.
- Only **2** dict-sort sites needed mirroring (`cl-map-sd`, `compile-module` free-ids),
  applied verbatim from the canonical cont compiler. The Promise backend then self-hosts to
  a byte-stable fixpoint in this tree (`phaseD-promise == phaseE-promise`,
  byte-identical; phaseE is a working compiler) — confirming the reference is
  canonical.

There is now a deterministic, canonically-sorted **Pyret-promise compiler colocated with
the TS compiler**, usable directly as the byte-parity reference:
`build/phaseA/pyret.jarr --stack-backend promise`.

## Goal statement

Add a `--stack-backend promise` flavor to the TS compiler that emits the async/await
backend, **byte-identical** to the in-tree Pyret-promise compiler, strictly additively
(the default cont behavior and all of `make ts-test` unchanged).

## Oracles (strongest-pinning first)

1. **PRIMARY — byte-identical emitted JS, TS-promise vs Pyret-promise.** For each parity
   program, compile with `build/phaseA/pyret.jarr --stack-backend promise` and with the
   TS-promise compiler; `cmp` the per-module cache files (`-static.js` + `-module.js`) and
   the standalone jarr. This pins exact codegen. It is achievable because the cont port
   already achieves byte parity Pyret-cont ≡ TS-cont, and the async backend preserves the
   same atom-creation/emission order — the residual work is mirroring the async backend's
   sort sites, exactly as cont did.

2. **Cross-backend run parity (within TS): TS-cont ≡ TS-promise** running the same program
   (program output + check-results), modulo the **8 sanctioned stack-trace-shape
   divergences**. This is the independent *semantic* check that catches Promise-leak /
   flatness-invariant bugs that byte-parity cannot (byte-parity only proves "matches the
   reference").

3. **Suite parity: TS-promise `main2` ≡ Pyret-promise (13008 / 8 / 0).** Re-point the
   existing `ts-pyret-test` harness at the promise backend + `runtime-async.js`; expect the
   identical *failing set* (compare the set, not the count — `test-pprint` is nondeterministic).

4. **Self-host byte check + safe-for-space heap acceptance.** TS-promise compiles the Pyret
   compiler sources `--stack-backend promise` and matches Pyret-promise's bytes (the promise
   analogue of the cont port's phaseB self-build). And a TS-promise-compiled
   `tests/async-opt/bench-mutual.arr` runs in **O(1) heap** (~133 MB at 1M–20M deep) — the
   only thing that proves the token-minting codegen and the runtime driver work *together*.

5. **Compiler stack-safety under a constrained stack (browser proxy).** The byte oracle is
   structurally blind to whether the compiler *recurses or iterates* while compiling — but a
   recursive compiler overflows the browser's ~1 MB stack on deep programs (the reason the
   cont TS compiler is generator/explicit-stack-based). Proxy it in node, no browser needed:
   compile a deep (≥~1500-statement) straight-line program with the compiler's library entry
   driven **directly** under a constrained V8 stack (`node --stack-size≈1000`) — the library
   entry, not the CLI, because the CLI re-execs itself with `--stack-size=8192` and would
   cancel the constraint — and require no `RangeError`. **Self-calibrate against cont:** the
   same program + `--stack-size` must compile cleanly under TS-cont (the proven-iterative
   baseline), so the bar is "as stack-robust as cont," not a magic threshold (and a too-low
   `--stack-size` that hard-crashes V8 rather than throwing is mis-calibrated, not a failure).

## Constraints (hold for every change)

- **Strictly additive.** Default build + behavior unchanged; new functionality in new files
  and small flag-guarded edits at existing dispatch points. `make ts-test` green throughout.
- **The flatness ⟺ async-ness invariant.** Every await decision (call, method-app, update,
  annotation check, primitive app) AND the sync-vs-async function-emission decision must use
  the *same* flatness verdict (`flatness.ts`: `annFlatness`, `getFlatnessForModuleCall`,
  `isFunctionFlat`). A mismatch = JS syntax error (`await` in sync fn) or Promise leak. The
  byte oracle catches the syntax-error class instantly; cross-backend run parity catches the
  Promise-leak class.
- **Lockstep sorting.** Any new dict iteration introduced in the async backend must be sorted
  in BOTH the Pyret reference (`anf-loop-compiler-async.arr`) and the TS port
  (`anf-loop-compiler-async.ts`), or byte-parity silently breaks.
- **Backend-keyed caches, never mixed.** Cont- and promise-compiled modules share a
  source-only hash but emit incompatible JS; they must live in separate dirs.

