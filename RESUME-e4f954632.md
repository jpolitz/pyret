# Resume: implement SAFE-FOR-SPACE tail calls (async/promise backend)

Forward-looking plan for the next session. Branch **`async-transform`**. Tagged
with the resume-point commit (**`e4f954632`**); if you checkpoint, drop a new
`RESUME-<shorthash>.md`. The functional backend + the perf push are DONE and
committed; this is the next feature.

## Read first (in order)
1. Project memory `async-transform.md` — full backend history + the
   safe-for-space gap entry + lessons (cache-dir-is-backend-keyed, the perf
   `setTimeout→util.suspend` lesson, the flatness⟺async-ness model).
2. **`DESIGN-safe-for-space-tco.md`** — the design we converged on (this is the
   spec for the work below; read it fully before coding).
3. This file — the implementation plan + validation gates.

## The goal (one sentence)
Make CROSS-FUNCTION (mutual) tail recursion safe-for-space (O(1) heap) on the
promise backend, fully dynamically (must cover higher-order / first-class /
cross-module tail calls — partial/static is unacceptable), without changing the
calling convention, and without regressing the perf numbers we just won.

## The problem (why)
Self tail calls already loop (`while(true){…;continue}` → O(1)). A mutual tail
call compiles to `return await g.app(...)` → O(n) chain of retained suspended
async frames. Reproducer **`tests/async-opt/bench-mutual.arr`** (is-even/is-odd):
promise grows ~626 B/level and OOM-aborts ~5M depth; cont is flat ~136 MB (its
trampoline bounces every tail call). The leak is the *result-dependency chain*,
not the native stack (GAS keeps that bounded). No JS engine helps (only JSC does
PTC; V8 removed it); await / no-await / Promise<Promise> are all O(n). See the
design doc for the full reasoning and the rejected approaches.

## The design to build (summary — full version in DESIGN-safe-for-space-tco.md)
Bounce token + driver, **polarity flipped so the safe path is the default:**
- Public **`.app` DRIVES** — runs the body, loops on tokens, returns a real
  value. FFI and non-tail call sites use it unchanged; tokens NEVER escape to a
  `.app` caller. JS-to-Pyret stays correct calling raw `.app`.
- Internal **`appBody`** runs the body and, at a TAIL position, returns
  `R.tailCall(f, args)` (a token) instead of awaiting. The driver loop in `.app`
  pumps `r.fn.appBody(...)` (NOT `.app`, so no nesting) until it gets a value.
- Plain JS functions default `appBody = app` → they return a value and END the
  chain (anchor one frame; correct; opt-in to participate by supplying an
  `appBody` that mints tokens).
- Compiler: tail-position call → `return R.tailCall(f, args)`; non-tail call →
  unchanged (`await f.app(args)` returns a value). Self tail calls → KEEP the
  existing `while(true){continue}` loop (no per-iteration token alloc).
- The `.app` drive-wrapper (one extra async hop) only exists for functions that
  can produce a token (end in a tail call); `fib`/non-tail-recursive keep
  `.app === .appBody`, zero overhead.

Runtime sketch (goes in runtime-async.js; `R` = the runtime object):
```js
function TailCall(fn, args){ this.fn = fn; this.args = args; }
R.tailCall = function(fn, args){ return new TailCall(fn, args); };
// public driver entry (only for token-producing fns; others: app === appBody)
async function drivenApp(...args){
  var r = await this.appBody.apply(this, args);
  while (r instanceof TailCall) r = await r.fn.appBody.apply(r.fn, r.args);
  return r;
}
```

## Suggested implementation order (prototype → validate → widen)
1. **Runtime first:** add `TailCall` + `R.tailCall` + the driver; expose them.
   Decide how a PFunction carries both entries (`makeFunction`/`mF` builds the
   function value — give it `.appBody` and a driving `.app`, defaulting
   `appBody=app` for plain JS fns). Anchor: `src/js/base/runtime-async.js`.
2. **Compiler:** at a TAIL-position app, emit `return R.tailCall(f, args)`
   instead of `return await f.app(...)`; emit the function with an `appBody`
   (token-producing body) + a driving `.app` wrapper *only when the body can
   produce a token* (ends in a non-self tail call). Keep self-TCO loop as-is.
   Anchors: `compile-app-async` (tail-call emission, is-tco branch ~1193),
   `compile-fun-body` / `compile-a-lam` (function emission ~1334/1455),
   `anf-loop-compiler-async.arr`.
3. **Guard the invariant:** tokens must NEVER be observable as Pyret values
   (no `getField`/equal/`==`/print/torepr path can see a `TailCall`). Add a guard
   test under `tests/async-opt/` (à la `helper-reentry`) that would catch a leaked
   token. Audit FFI/runtime spots that stash a raw `.app`/`appBody` return before
   driving.
4. **Widen carefully:** first-class tail calls (callee is a runtime value) — the
   token references `r.fn.appBody`, so every function value needs `.appBody`;
   confirm builtins/closures/methods all carry it. Cross-module: same, since it's
   all dynamic via the function value.

## Validation gates (run ALL after changes — this is the point of the guards)
1. After compiler .arr: `make phaseA`. After runtime .js: `cp
   src/js/base/runtime-async.js build/phaseA/js/` + `rm -rf compiled-promise
   tests/compiled-promise build/phase?-promise` (stale cache is the #1 red
   herring; caches are backend-keyed).
2. **`tests/async-opt/bench-mutual.arr` becomes O(1)** — promise maxRSS flat in
   depth (match cont ~136 MB) and completes at 5M/20M without OOM. THIS is the
   feature's acceptance test. (Build: `make tests/async-opt/bench-mutual.p.jarr
   EF=' '`; measure `/usr/bin/time -f "%e s, %M KB" node …p.jarr`.)
3. **`make async-opt-test`** — tco-test 16, flat-sanity 13, helper-reentry-pyret
   7, helper-reentry 11. MUST stay green (re-entry/stack safety unbroken).
4. **`make all-pyret-test-promise EF=' '`** — must stay **13000/13005** (only the
   5 spec-flagged test-repl check-block-6 stacktrace pins fail; a token leak shows
   up as "Non Pyret value:"/contract errors / new fails).
5. **`make new-bootstrap-promise`** — compiler self-hosts to byte-identical
   `cmp build/phaseD-promise/pyret.jarr build/phaseE-promise/pyret.jarr`.
6. **Re-benchmark `tests/async-opt/bench-{flat,listsum,nontail,map,tco,boids,
   boids-raster}`** cont vs promise; confirm NO regression vs current
   (flat 1.09/listsum 1.04/map 1.19/nontail 1.41/tco 1.75; boids 1.32/raster
   1.24). The extra `.app→appBody` hop must not land on non-token-producing fns.
   Outputs must stay byte-equal across backends.

## Single-file build/run commands (from `lang/`)
- async-opt test/bench (promise): `node build/phaseA/pyret.jarr --outfile T.p.jarr
  --build-runnable tests/async-opt/T.arr --builtin-js-dir src/js/trove/
  --builtin-arr-dir src/arr/trove/ --compiled-dir compiled-promise/
  --stack-backend promise -check-all --require-config
  src/scripts/standalone-configA-async.json && node T.p.jarr`
- bench (no checks): `make tests/async-opt/T.jarr EF=' '` (cont) /
  `make tests/async-opt/T.p.jarr EF=' '` (promise).
- Inspect emitted JS for a fn: decode the `theModule` string in the built
  `.p.jarr` (it's escaped JS); search for the fn's `appBody`/`.app`/`TailCall`.

## Traps
- Cont keys self-TCO on ANF `app-info.is-tail` (the async backend trusts the same;
  the `tail-pos` gate was dropped — don't reintroduce it). Mutual tail calls also
  have `app-info.is-tail = true` but no self-loop to `continue` to — that's the
  case to route to a token.
- Return annotations: `fun f(…) -> T:` desugars the tail call to `let ans = f(…)
  in _checkAnn(T, ans)` → non-tail on BOTH backends. `bench-mutual.arr` omits anns
  on purpose to get a genuine tail call. Decide if/how annotated tail calls should
  participate (probably stay non-tail, matching cont).
- Don't couple any of this to flatness/ann-check elision (the unsound trap from
  the perf notes).
