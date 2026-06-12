# Design notes: safe-for-space tail calls on the async/promise backend

Status: **design only, not implemented.** Captures a design conversation. The
problem is real and measured (`tests/async-opt/bench-mutual.arr`); the fix below
is a sketch we converged on but have not built or validated.

## The problem

The async backend is **not safe-for-space for cross-function (mutual) tail
recursion.** A *self* tail call already compiles to a `while(true){…;continue}`
loop → O(1). A *mutual* tail call `is-even → is-odd → is-even → …` compiles to
`return await is$odd.app(n-1)`, which is not a JS tail call: each level suspends a
heap-allocated async frame that the level above retains, so the chain is O(n)
live frames. GAS keeps the *native* stack from overflowing (periodic
`await checkPause()` unwind every INITIAL_GAS entries) but cannot reclaim the
suspended-frame chain.

Measured (`bench-mutual.arr`, `is-even`/`is-odd`, no return anns so the tail call
is genuinely tail):

| depth | cont maxRSS | promise maxRSS |
|---|---|---|
| 250k | 136 MB | 350 MB |
| 500k | 136 MB | 518 MB |
| 1M | 137 MB | 843 MB |
| 2M | 135 MB | 1469 MB |
| 5M | 136 MB (1.0s) | OOM abort @ ~2.2 GB |

Promise grows ~626 bytes/level (linear, O(n)); cont is flat (O(1), trampoline
bounces every tail call to a synchronous top loop). **This is a dramatic
regression vs cont and the fix must be fully dynamic and complete** (all tail
calls — including higher-order, first-class, cross-module — must be
safe-for-space; a partial/static fix is unacceptable per the project owner).

## What JS engines give us (ground truth)

- ES2015 specs Proper Tail Calls, but **only JavaScriptCore/Safari implemented
  them** (strict mode). **V8/Node shipped PTC behind a flag in 2016, then removed
  it** (silent frame elision breaks `Error.stack`/DevTools; implicitness); the
  syntactic-tail-call counter-proposal died. SpiderMonkey never shipped. So Node
  has no TCO and no flag enables it.
- **Dropping the `await` does not help.** `return await g()` → O(n) suspended
  execution contexts. `return g()` (no await, g returns a promise) → O(n)
  *promise-adoption chain* (each link must stay live to propagate the value up),
  plus extra microtask ticks. The `await` is exactly the operation that trades
  O(n) native stack for O(n) heap; the promise machinery has no third setting.
- **Promise<Promise> flattening cannot reclaim the chain.** Flattening is
  value-level and lazy-via-adoption: resolving A with thenable B attaches a
  reaction to B (one link), it does not path-compress A→B→C→… into A→value while
  pending. The collapse only happens at settle time by walking all N links. While
  pending, the whole chain is reachable from the microtask-queue root. So you
  can't exploit it for space.

**The leak is the result-dependency, not the frames or the native stack.** Any
scheme where the caller waits for (awaits, or adopts the promise of) the callee's
result builds an O(n) chain. O(1) requires intermediate results to be either
**consumed-and-discarded by a loop** (bounce token + driver) or **never waited on
at all** (CPS — thread a continuation down, base case invokes it).

## Rejected approaches

- **Static SCC grouping** (compile a mutually-tail-recursive letrec group into one
  dispatch loop). Zero hot-path cost but only catches statically-named, same-group
  recursion — higher-order / first-class / cross-module tail calls still leak.
  **Partial ⇒ unacceptable.**
- **`driven` bit threaded to distinguish chain-entry from continuation, as a
  runtime global.** The bit *stripes* the stack: a driven frame can make a
  non-tail call that enters non-driven and starts its own driver (true/false/true
  coexist on the stack). A global gets misread/clobbered across stripes and across
  `await` suspensions; making it correct needs save/restore at every non-tail call
  + `try/finally` — more spots than it saves, and fragile.
- **`driven` bit as a real parameter / calling-convention change.** Correct
  (per-frame, await-safe) but changes every function signature. Rejected: don't
  want to touch the calling convention.
- **`return Promise.resolve().then(() => tail())`.** Fixes the native stack (each
  tail call runs in a fresh microtask, O(1) depth — but GAS already does that) and
  does NOT fix the heap (the `.then`/async-return adoption chain is still O(n)).

## The design we converged on (bounce token + driver, with the right polarity)

Static call-site placement, **no `driven` bit, no signature change.** The compiler
already knows statically whether a call is in tail position.

- **Tail-position call** → `return R.tailCall(f, args)` — mint a token, don't
  await. Forwarded up to the nearest driver.
- **Non-tail-position call** → drive to a real value (the value is consumed).

**Polarity is the key decision (resolves the FFI worry).** Make the *public*
`.app` the driver — safe and value-returning by default — and put the
token-producing entry *internal*:

```js
// internal: runs the body; tail calls mint tokens (may return a TailCall)
fn.appBody = async function(...args) { …; return R.tailCall(is$odd, [n-1]); };

// public: the safe, value-returning entry. drives any chain to a value.
fn.app = async function(...args) {
  var r = await fn.appBody(...args);
  while (r instanceof R.TailCall) r = await r.fn.appBody(...r.args);
  return r;
};
R.tailCall = function(fn, args) { return new R.TailCall(fn, args); };
```

- The driver calls `r.fn.appBody` (NOT `.app`) → never re-drives → no nesting →
  O(1) for `is-even`/`is-odd` (the chain runs as iterations of one `.app` frame's
  loop; each `appBody` frame returns a token and dies).
- A plain JS function with no `.appBody` defaults `appBody = app`: it returns a
  value and *ends* the chain (anchors one frame — correct, opt-in to do better).

### Why this polarity matters (the whole point)

- **JS-to-Pyret FFI is unchanged and correct.** `await pyretFn.app(args)` drives →
  always a value, never a token. No FFI site needs a special "safeTail" call for
  correctness. Tokens never escape to a `.app` caller.
- **Safe is the default; fast/dangerous (tokens) is internal/opt-in.** The only
  opt-in is *participation*: a JS helper that wants to be a transparent O(1) link
  supplies an `appBody` that mints tokens; if it doesn't, it's still correct, it
  just anchors the chain through its own frame.
- **Cost lands only where the mechanism is needed.** The `.app` drive-wrapper (one
  extra async hop on entry) is needed only for functions that *can* produce a token
  (end in a tail call). `fib` and every non-tail-recursive function keep
  `.app === .appBody` — zero overhead — and all FFI consumers pay nothing.
- Loop helpers (`map`, etc.) *consume* the callback result (store it), so they are
  drivers by definition: `newArray[i] = await f.app(x)` — get a value, the
  callback's internal tail recursion is driven by `f.app`'s loop. Helpers don't
  forward tokens; consumers drive.

## Open questions before implementing

- **Tokens must never be storable as Pyret values** — they may exist only in
  transit between an `appBody` return and a driver. Compiled code guarantees this
  by construction, but a guard (à la `helper-reentry`) should assert no
  `getField`/equality/print/`==` path can ever observe a `TailCall`. Audit FFI
  spots that grab a raw `.app`/`appBody` return and stash it before driving.
- **Self-recursion:** keep the existing `while(true){continue}` loop (no token
  alloc per self-iteration) and use tokens only for cross-function tail calls — or
  make self-calls bounce too (uniform but allocates). Lean: keep `continue`.
- **Cost measurement:** the extra `.app→appBody` hop for token-producing functions
  needs benchmarking against the current numbers (`tests/async-opt`), and against
  cont, before committing. Confirm the non-tail / `fib` path is untouched.
- Interaction with the existing return-annotation TCO handling (`-> T` desugars to
  `let ans = f(…) in _checkAnn(T, ans)` — already required dropping the `tail-pos`
  gate for self-calls; mutual calls with anns are non-tail on *both* backends).

## Where things live
- Reproducer: `tests/async-opt/bench-mutual.arr` (depth knob; OOMs promise ~5M).
- Self-TCO loop emission today: `src/arr/compiler/anf-loop-compiler-async.arr`
  `compile-app-async` (is-tco / get-assignments / j-continue), `compile-fun-body`.
- Runtime fuel/await: `src/js/base/runtime-async.js` `needsPause`/`checkPause`.
- cont's trampoline (the O(1) reference): `src/js/base/runtime.js` `iter`/safeCall
  (`++GAS` on return at 3477/3507; `util.suspend` macrotask only on RUNGAS).
