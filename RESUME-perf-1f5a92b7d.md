# Resume: async/promise backend — PERFORMANCE push

Forward-looking plan for the next round: close the async-backend's runtime
overhead vs the cont/trampoline backend. Branch **`async-transform`**. This file
is tagged with the short hash of the resume-point commit (**`1f5a92b7d`**, the
last substantive work commit); if you checkpoint again, drop a new
`RESUME-perf-<shorthash>.md`. Read the project memory `async-transform.md` first;
this file is the perf-specific plan.

The functional work is DONE and validated (full suite at parity bar 5 spec-flagged
stacktrace pins; compiler self-hosts to a byte-stable fixpoint; TCO-through-return-
annotation fixed this round). What remains is *speed*.

## Where we stand (same-machine, cont = unmodified trampoline = 1.0×)

| benchmark | shape | ours (promise) | opt-tests (theirs) |
|---|---|---|---|
| bench-flat | annotated tail, flat-builtin calls | 1.1× | 1.0× |
| bench-listsum | annotated tail, list build+sum | 1.8× | 1.7× |
| bench-tco | annotated tail, 200k×200 | 2.8× | 2.1× |
| bench-nontail | non-tail fib (TCO N/A) | 2.4× | 1.65× |
| **bench-map** | shallow tail + flat `map`/`fold` | **2.7×** | **1.0×** |

Full suite / test-numbers / bootstrap: ~1.0× (jsnums + compilation dominate; the
await tax only shows in deliberately await-bound loops). Build + time a single
benchmark:
```
make tests/async-opt/bench-map.jarr            # cont (trampoline)
make tests/async-opt/bench-map.p.jarr EF=' '   # promise
/usr/bin/time -f "%e s, %M KB" node tests/async-opt/bench-map.p.jarr   # from lang/
```

## What is ALREADY done — do NOT redo (flatness)

The flatness optimization is fully in place on this branch (Stages 3–4). Verified
in `anf-loop-compiler-async.arr`:
- flat **function calls** skip the await — `compile-app-async`:
  `value = if is-flat: call-base else: j-await(call-base)` (~line 1205);
- flat **prim-apps** (arithmetic `-`/`<`/`+`) skip the await — a-prim-app branch:
  `value = if app-info.needs-step: j-await(call) else: call` (~line 1311);
- flat **functions** emit as sync `j-fun` with NO entry fuel check; non-flat as
  `j-async-fun` (compile-a-lam ~line 1463, compile-fun-body `fuel-check`);
- flat **annotations** check synchronously (`ann-check-stmts` gated on
  `is-flat-enough(FL.ann-flatness(...))`).
This is the same shipped flatness work as opt-tests `ce6fe4194`, and is why
bench-flat is already ~1.1×. **The remaining gap is NOT flatness** — it is the
per-element await in the higher-order loop helpers (bench-map), plus possibly a
small residual await tax on tight loops.
- First diagnostic step anyway: profile/inspect the emitted JS for bench-nontail
  and bench-tco to confirm NO flat op is still being awaited (if `needs-step` /
  `is-flat` is ever conservatively true where cont treats it flat, that's free
  speed). `node --prof` or just read the `theModule` string for `fib`.

## The target pattern (the user's design)

opt-tests shipped a **helper-loop conditional-await**: a loop helper calls its
callback and only `await`s if the callback actually returned a Promise — flat
(value-returning) callbacks skip the per-element microtask. Their shape
(runtime-async.js in opt-tests, e.g. their raw_array_map ~line 4041):
```js
var res = f.app(x);
if (res instanceof Promise) { newArray[i] = await res; }   // non-flat callback
else { newArray[i] = res; if (needsPause()) { await pause(); } }  // flat: skip await
```
**Their hole** (open in their notes, `async-reentry-fuel-design.md`): `f.app(x)`
runs FIRST and the fuel charge is only in the else branch — a re-entrant flat
callback descends the native stack with no fuel check and **overflows** (~2.5k
deep for a fuel-less FFI callback; our `helper-reentry.arr` guard asserts their
"OVERFLOW").

**Our pattern = theirs, but charge fuel + checkPause BEFORE the potentially-sync
call.** Crucially, our helpers ALREADY do this — they `if(needsPause())await
checkPause()` before `await f.app(...)`. So the change is *only* to make the
`await` conditional, keeping the pre-call fuel charge:
```js
for (var i = 0; i < length; i++) {
  if (thisRuntime.needsPause()) { await thisRuntime.checkPause(); }  // FUEL FIRST — bounds re-entry
  var res = f.app(arr[i]);                                            // possibly-sync, possibly re-entrant
  newArray[i] = (res !== null && typeof res === "object" && typeof res.then === "function")
    ? await res : res;                                               // await ONLY if a thenable
}
```
This is the win (no microtask for flat callbacks) WITHOUT the hole (fuel-before-
call bounds the re-entrant descent every INITIAL_GAS levels). It's the same
thenable-aware shape already proven in our `safeCall` (Stage 4, runtime-async.js
~line 3308). Use one shared helper, e.g.
`function settle(res){ return (res && typeof res.then === "function") ? res : ...}`
— but inline the `await` (can't await inside a non-async helper); a small macro/
copy per site is fine.

### Primary target — the loop helpers (bench-map)
Apply the conditional-await to each, KEEPING the existing pre-loop
`if(needsPause())await checkPause()`. In `src/js/base/runtime-async.js`:
- `raw_array_map` (~4292), `raw_array_each` (~4305), `raw_array_mapi` (~4317),
  `raw_array_map1` (~4367)
- `raw_list_map` (~4330), `raw_list_filter` (~4381), `raw_list_fold` (~4421)
- `eachLoop` (~3316)
- (`raw_array_fold`, `raw_array_bool_mapper`, builders — same shape if present)
bench-map exercises `map` + `fold` over a flat callback, so raw_list_map +
raw_list_fold are the headline. Expect bench-map 2.7× → ~1.0×.

### Secondary target — call sites (bench-tco / bench-nontail)
The per-call await tax on NON-flat calls (the fib recursion, the tco loop's
re-entry) is the residual. A call-site conditional-await is harder: the sync-vs-
async function-emission boundary means you can't `await` inside a flat (sync)
`j-fun`. But for calls *inside async functions* that are statically non-flat yet
often return synchronously, `compile-app-async`'s non-flat branch
(`j-await(call-base)`) could emit `var r = f.app(...); if (r&&r.then) r = await r;`
— SAFE because the callee's own entry fuel check provides fuel-before-work, and a
non-tail call is a fresh function entry. Prototype this AFTER the loop helpers and
measure; it's a bigger blast radius (every call site) so gate hard.

## Soundness traps (opt-tests hit these — heed them)

1. **Conditional-await + annotation elision (they reverted this, unsound).** Their
   notes: a "static-flat-ann ⟹ synchronous `_checkAnn`" assumption has a gap — with
   the optimization on, a flat-looking ann can still flow a Promise at runtime, and
   eliding the `await` skips the contract check AND leaks the Promise. Do NOT couple
   the conditional-await to ann-check elision. Keep `_checkAnn` awaiting exactly per
   the flatness verdict it already uses. The loop-helper opt does not touch anns, so
   it is clean; the call-site opt must not weaken ann checks.
2. **The thenable test must be robust.** `res instanceof Promise` misses thenables
   from other realms / makeFunction-wrapped async fns; prefer
   `res && typeof res.then === "function"`. A false negative (treating a Promise as a
   value) leaks "Non Pyret value: Promise" into the next op — the universal symptom
   (see the `_checkAnn` LEAK probe in the memory).
3. **Fuel MUST stay before the call.** If you ever move `needsPause()` after
   `f.app`, the `helper-reentry.arr` guard flips to OVERFLOW (by design). That guard
   is the canary — keep it green.

## Validation gates (run ALL after each change; this is the point of the guards)

1. `make phaseA` (after any compiler .arr) / `cp runtime-async.js build/phaseA/js/`
   + `rm -rf compiled-promise tests/compiled-promise build/phase?-promise` (after
   any runtime .js). Stale cache is the #1 red herring.
2. **`make async-opt-test`** — the stack-safety/TCO/flatness guards (tco-test 16,
   flat-sanity 13, helper-reentry-pyret 7, helper-reentry 11). `helper-reentry`
   going red = you reintroduced the re-entry overflow. MUST stay green.
3. **`make all-pyret-test-promise EF=' '`** — full suite. Must stay 12997/13002
   (only the 5 test-repl stacktrace pins fail). A conditional-await soundness bug
   shows up as new failures / "Non Pyret value: Promise" / contract errors here.
4. **`make new-bootstrap-promise`** — compiler self-hosts to byte-identical D==E.
   The strongest soundness check (the compiler is a huge annotated program).
5. **Re-benchmark** all of tests/async-opt/bench-*.arr, cont vs promise, and update
   the REPORT.md Performance table. Confirm outputs are byte-equal across backends.

Commit per the spec cadence (test-run + results in the message). The benchmarks,
guard tests, and REPORT Performance section are already in tree; extend them.

## Key file/line anchors (verify before relying — code moves)
- `src/js/base/runtime-async.js`: loop helpers 3316/4292/4305/4317/4330/4367/4381/
  4421; `safeCall` (thenable-aware template) 3308; `needsPause` 3343 / `checkPause`
  3358 (macrotask yield on RUNGAS; INITIAL_GAS=500, INITIAL_RUNGAS=5000).
- `src/arr/compiler/anf-loop-compiler-async.arr`: `compile-app-async` 1165 (await
  decision 1205); a-prim-app await decision ~1311; compile-fun-body fuel-check
  ~1395; flat-vs-async emission compile-a-lam ~1463.
- opt-tests reference: `/home/exedev/attempts/4.8/opt-tests` — runtime-async.js
  conditional-await sites (~3865/4005/4041/4068); `async-optimization-findings.md`,
  `async-session-handoff.md` (their numbers + the reverted unsound experiments),
  `async-reentry-fuel-design.md` (the re-entry hole their design left open — the
  one we close by charging fuel first).
