# Resume: methods in safe-for-space tail calls (+ lazy-trace idea)

Branch **`async-transform`**. Resume-point commit **`b749bda28`**. The
async/promise backend, the perf push, and **safe-for-space mutual tail calls**
are all DONE and committed. This file is the next feature: making **methods**
participate in the bounce so method-mediated mutual recursion is O(1) too.

## Read first (in order)
1. Project memory `async-transform.md` — full backend history; the
   **SAFE-FOR-SPACE TAIL CALLS — DONE** entry has the bounce-token/driver design,
   the closure-not-`this.appBody` lesson, and the guard-test breakdown.
2. **`REPORT.md`** § "Safe-for-space tail calls" — the spec/rationale for what's
   built (read it before touching the mechanism).
3. `DESIGN-safe-for-space-tco.md` — the original design conversation (the
   rejected approaches still apply: static SCC = partial, driven-bit = unsafe).
4. This file.

## What's DONE (don't redo)
Cross-function (mutual / higher-order / cross-module) tail calls between
**functions** are O(1) heap. `PFunction` carries `.app` + `.appBody` (default
equal); `makeTailFunction` keeps the token-minting body as `appBody` and makes
`.app` a driver closure. The compiler mints `return R.tailCall(f, [args])` at a
genuine tail position (complete-return), in an async body, to a non-flat callee;
records it per-function in a `token-cell` so `compile-a-lam` emits
`makeTailFunction` only when a token was actually minted (else plain
`makeFunction`, zero overhead). Self tail calls keep the `while(true){continue}`
loop. Validated: `bench-mutual` flat ~133 MB at 1M–20M; cross-module + cases-
branch heap-verified O(1); `mutual-tco-test.arr` 45 checks (incl. exceptions
through a bounce); suite 13010/7-fail (frame-shape pins only); bootstrap D==E.

## The gap: methods drive O(n)
A tail call **through a method** is NOT safe-for-space. Methods are `PMethod`
(`meth` curried / `full_meth` full), not `PFunction` (`app` / `appBody`), so
`compile-a-method` is called with `can-mint-tokens = false`
(anf-loop-compiler-async.arr ~1825) and `compile-method-app-async` always drives
to a value (`return await maybeMethodCall(...)`). Correct, matches cont, but a
mutual recursion routed through methods (`self.od(n-1)` ⇄ `self.ev(n-1)`) builds
O(n) suspended frames. Pinned correct-but-O(n) by the "mutual recursion through
methods" check in `mutual-tco-test.arr` (depth 100k) — that check stays green if
this feature lands and a memory probe would flip to flat.

## Design to build (mirror the function mechanism, two token kinds)
Give `PMethod` the same split, and teach the ONE driver to bounce both kinds so a
function⇄method mixed chain stays flat (the driver must handle both because a
function can tail-call a method and vice-versa).

**Runtime (`runtime-async.js`):**
- `PMethod` gains `full_methBody` (default `=== full_meth`, so plain methods end
  a chain by returning a value — same anchoring trick as `appBody`).
- New token `TailMethodCall(m, obj, args)`; `R.tailMethodCall(m, obj, args)`.
- The driver loop (currently in the `makeTailFunction` closure) handles BOTH:
  ```js
  while (true) {
    if (r instanceof TailCall)       r = await r.fn.appBody.apply(r.fn, r.args);
    else if (r instanceof TailMethodCall)
                                     r = await r.m.full_methBody(r.obj, ...r.args);
    else break;
  }
  ```
  Factor the loop into a shared `drive(r)` so `makeTailFunction` and a new
  `makeTailMethod` reuse it (keep the closure-over-body property — don't read
  `this`; bare `.app`/method extraction loses `this`, see the DONE lesson).
- `makeTailMethod(methFn, fullMethFn, name)`: `full_methBody = fullMethFn`,
  `full_meth = ` a driver wrapper that calls `drive(await fullMethFn(obj,...args))`.
  Also handle the curried `meth` form (`appN`/`makeMethodN`) — it calls
  `full_meth(obj, ...)`, so the driving `full_meth` covers it.
- `PMethod.prototype.brand`: re-wrap via `makeTailMethod` when
  `full_meth !== full_methBody` (parallels the `app !== appBody` fix).

**Compiler (`anf-loop-compiler-async.arr`):**
- `compile-a-method` (~1825): pass `can-mint-tokens = true` and give it a fresh
  `token-cell` (like `compile-a-lam`); emit `makeMethod*`/`makeTailMethod*` based
  on whether the body minted. The body is non-flat (methods are async) so
  `mints-tokens = can-mint and not(is-flat)` is just `can-mint`.
- `compile-method-app-async`: at a TAIL position (`compiler.mints-tokens and
  compiler.tail-pos`), mint `R.tailMethodCall(resolvedMethod, obj, [args])`
  instead of `return await maybeMethodCall(...)`. **Open detail:** the token needs
  the resolved method VALUE + obj. `maybeMethodCall` resolves internally
  (getColonField + isMethod branch); minting needs that resolution hoisted so the
  token carries `(methodVal, obj, args)`. Mind the two shapes in
  compile-method-app-async (the `j-id` fast path vs the obj/field/ans branch).

## Open questions / risks to settle while building
- **Token-kind dispatch cost.** The driver loop now does two `instanceof` checks
  per bounce. Bench `bench-mutual` (function-only) after — must NOT regress; if it
  does, order the function check first (hot path) or tag tokens with a small int.
- **Method resolution timing.** Resolving the method to mint a token must have the
  same effects/error behavior as `maybeMethodCall` (non-method field → throw). Keep
  the `isMethod` check before minting.
- **`run-task` / FFI.** Same guarantee as functions: `full_meth` always returns a
  value (drives), so FFI that calls `full_meth` is unchanged. Verify the trove
  spots that grab a raw `full_meth` (grep `full_meth` in src/js).
- **Is it worth it?** Methods are a rare mutual-recursion vehicle. If the dispatch
  cost or the resolution plumbing is ugly, "document-only" (status quo) is a
  legitimate stopping point — the owner's "complete" bar is about HO/first-class/
  cross-module *function* calls, which are done. Decide deliberately.

## Validation gates (run ALL after changes)
Same as the function feature — see memory `async-transform.md`:
1. `make phaseA`; after runtime .js: `cp src/js/base/runtime-async.js
   build/phaseA/js/` + `rm -rf compiled-promise tests/compiled-promise
   build/phase?-promise`.
2. Add a "methods O(1)" memory probe (a method ev⇄od at 1M/5M/20M, assert flat
   maxRSS) — the new acceptance test; flip the `mutual-tco-test` methods note.
3. `make async-opt-test` — mutual-tco-test (45→+ checks), helper-reentry 11, etc.
4. `make all-pyret-test-promise` — stays at parity (only the test-repl
   check-block-6 frame-shape pins; a token leak shows up as "Non Pyret value:" /
   contract errors / new fails).
5. `make new-bootstrap-promise` — D==E byte-identical.
6. Re-bench `tests/async-opt/bench-*` — no regression; outputs byte-equal.

## Secondary future idea: lazy-trace ring buffer (optional)
Our scheme is **eager** frame collection (the `appBody` frame dies at the tail
call); cont is **lazy** (ActivationRecords linger, read on demand) — that's why
our stack traces collapse harder (the +2 test-repl pins). The value-flow MUST
stay eagerly bounced (the O(n) proof forbids lazy retention of the result
dependency), but the **trace is a separable object**: have the token carry its
`apploc` and the driver keep the last K `(fn, apploc)` in a cyclic buffer
(O(K)=O(1) memory). On a raise, reconstruct a K-deep trace — recovering cont's
shallow-depth fidelity (most test-repl pins would close) with a correct truncated
suffix at depth. Gate behind a debug flag so the hot path pays nothing. NB: the
"let the await chain accumulate K frames then collapse in batches" reading is a
dead end (re-nests drivers, no time win, more peak memory) — retain trace
*metadata*, not live frames.

## Single-file build/run (from `lang/`)
- async-opt test/bench (promise): `node build/phaseA/pyret.jarr --outfile T.p.jarr
  --build-runnable tests/async-opt/T.arr --builtin-js-dir src/js/trove/
  --builtin-arr-dir src/arr/trove/ --compiled-dir compiled-promise/
  --stack-backend promise -check-all --require-config
  src/scripts/standalone-configA-async.json && node T.p.jarr`
- bench mem: `make tests/async-opt/T.p.jarr EF=' '` then
  `/usr/bin/time -f "%e s, %M KB" node tests/async-opt/T.p.jarr`.
- Inspect emitted JS: grep `makeTailFunction` / `R.tailCall` / (new)
  `makeTailMethod` / `R.tailMethodCall` in the built `.p.jarr`.
