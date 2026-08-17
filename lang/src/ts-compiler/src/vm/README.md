# The hybrid bytecode machine (promise backend)

A second execution strategy for the promise backend's non-flat functions,
selected per function by the tier analysis and switched on with

```
pyret --stack-backend promise --vm-tiers gen ...      # (VM_TIERS in the Makefile; make foo.ts.h.jarr)
```

Nothing else about the system changes: the same front end, the same ANF
optimizer, the same `runtime-async.js`, the same module/cache format, the
same standalone. Modules built with and without the flag mix freely (a
hybrid module is an ordinary JS module that happens to carry a bytecode
program), which is why the *trove* can ship hybrid while a user program
compiles either way, and vice versa. Caches must not be shared across the
flag only because a hybrid module and its all-JS twin are different
artifacts (`compiled-ts-hybrid/`, `tests/ts-compiled-hybrid/`).

## The idea

The promise backend already computes, per function, a verdict of how it can
suspend (`tier.ts`: `flat | tail-flat | few-suspend | gen`). Flat functions
are plain sync JS; the two middle tiers are sync JS with a little suspension
scaffolding; **Gen** -- anything that can genuinely suspend in more than a
couple of places -- was an `async function`: a promise allocated per call,
a microtask per await, and every caller forced to await it.

The hybrid gives every Gen function TWO forms compiled from the same ANF:

1. **bytecode** for a small register machine that lives inside
   `runtime-async.js` (`R.$vm`), whose continuation is a heap object -- so
   suspending is trivial (park the frame, return one promise for the whole
   bytecode stack), tail calls reuse frames, and deep recursion lives on the
   heap; and
2. a **fast form**: the same body as a *plain sync JS function* in which
   every suspend site, instead of `await`, hands the machine its live values
   *when and only when* a thenable actually arrives (`R.$vm.bail`), and the
   machine interprets the rest of that activation.

Calls from JS run the fast form; the machine only ever runs code after a
real suspension (fuel exhaustion, I/O, a user refinement that paused),
which is rare, and it hands back to native code at the next bottom-frame
tail call. So in the common case a Gen function costs what a flat function
costs -- no promise, no await, no generator, no state machine anywhere --
and everything else the machine has (heap frames, one-object continuation,
proper tail calls) is available exactly where suspension is happening.
Flat / TailFlat / FewSuspend functions and the toplevel are untouched: they
are the leaves the machine calls into as compiled JS.

Numbers (paired, this box; see `tests/async-opt/vm/HYBRID-RESULTS.md`):
curated 16-bench geomean h/p **0.951**, compiler bootstrap ~0.97, compiled
trove **~35% smaller**; the hybrid-built compiler compiling the compiler
is byte-identical to the all-JS build.

## Where it sits

```
   ... anf ─ optimizer ─ weakening ─ direct fields ─ flatness ─ ann elision ─ tier analysis
                                                                                   │
                                            anf-loop-compiler-async.ts (compileALam / aMethod)
                                                    │                        │
                                       tier ∈ vmTiers?                  everything else:
                                                    │                        promise JS as before
                                        vm/vm-compile.ts  ──►  bytecode  +  fast form (JS, 'gen-fast' emission)
                                                    │
                                        one program per module: `var $BC = R.$vm.load(...)`
                                        at the top of the module's toplevel function
```

| file | role |
|---|---|
| `opcodes.ts` | instruction set, operand encodings, program format (`FORMAT_VERSION`) |
| `vm-compile.ts` | ANF function -> bytecode; suspend-site table + liveness for the fast form's bailouts; JS thunks for what is better emitted as JS |
| `disasm.ts` | decoder, disassembler, structural verifier, liveness |
| `../anf-loop-compiler-async.ts` | `vmRootExpr` (the seam), `compileGenFastFun` / `fastSite` (the 'gen-fast' emission), the tier-boundary boxing rule |
| `../../../js/base/runtime-async.js` | the machine (section "The hybrid bytecode machine"), `R.$vm = {load, mkFun, mkMeth, bail}` |
| `../../tests/vm-tools.js` | `disasm` / `verify` / `stats` over compiled modules |
| `../../tests/vm-unit-test.js` | opcode-table & format parity, verifier over caches (`make vm-unit-test`) |
| `../../../../tests/async-opt/vm/` | differential harness (`make vm-test`), tier-boundary programs, bootstrap timing |

## The seam, precisely

**Capture is by value in both directions.** ANF binds every name once;
Pyret's mutable bindings are `{"$var": v}` cells bound once. A bytecode
closure captures its free variables as an `upvals` array when it is built
-- from a bytecode parent through `CLOSURE`'s descriptors (local / upvalue /
constant / global), from a JS parent as `R.$vm.mkFun($BC, idx, [captures])`
with the JS variables listed by name. A JS-tier function nested inside a
bytecode function is a *thunk*: a JS function over its free variables that
the machine calls to build the closure. For all of this to be sound the JS
emitter's function-local var unboxing must not unbox anything a bytecode
function can see: `collectUnboxableVarKeys` keeps boxed every var declared
in, or referenced anywhere lexically inside, a VM-tier function.

**Module globals** (imports, builtins, type globals -- the module's
cross-module names, which the JS emitter declares as module-scope vars) are
handed to the loader once and read by bytecode with no capture. A local
*alias* to a global or a constant is captured as a global/constant upvalue
so the nested function's fast form sees it under the alias name.

**The Awaitable ABI is the contract**: `.app` / `.full_meth` on any Pyret
function returns a value or a thenable. A bytecode closure's `.app` is a
per-arity wrapper (arity check, run the fast form, `=== VM_BAIL` test,
resume in the machine); the machine's `CALL` to a JS callee applies it and
suspends on a thenable; a statically flat callee (`CALLFLAT`) skips both
the bytecode test and the thenable test -- flatness is the license. Tail
calls to JS from the bottom frame return the callee's result directly
(value or thenable): the same O(1) bounce the sync tiers use.

**Fuel.** Entering the machine from JS charges `needsPause()` like any
compiled non-flat function, which is what bounds the JS stack across
bytecode<->JS alternation. Bytecode->bytecode calls do not touch the JS
stack and consult the fuel once per `VM_FUEL_QUANTUM` calls (time-slicing
for the Stop button / event loop).

**Bailouts.** A fast form's suspend site is `t = <call>; if (R.iT(t))
return R.$vm.bail($BC, idx, pc, dest, t, [slots], [vals])` where `pc` is
the bytecode instruction after the *same* site (both forms are compiled
from the same ANF; the site's identity is the ANF node), `dest` the slot the
resumed value belongs in, and `[slots]/[vals]` the slots live at `pc`
(bytecode liveness, `disasm.liveInSets`) with the JS variables that hold
them (`FuncCtx.slotNames`). A site the bytecode did not record, or a live
slot without a name, is an `InternalCompilerError` -- never a fallback. The
fuel check bails at pc 0 with the current arguments (the explicit TCO loop
reassigns them), which re-runs the argument contracts exactly as the sync
tiers' re-entry-by-name does. Bytecode->bytecode calls interpret (heap
frames: deep recursion never pays a JS-stack pause storm); a bottom-frame
`TAILCALL` to a function with a fast form hands off to native code.

## The machine

Frames `{fdef, code, pc, locals, upvals, mod, dest, locK}`, pooled per
machine `State`, States pooled per entry; slot arrays built by pushing
(never `new Array(n)`: holey); tagged operands (`vs & 3`: local / upvalue /
constant / global); METHCALL and CASESBIND carry inline caches keyed on
`$constructor` (allocated per module instantiation, never on the program);
DOT inlines `getFieldLoc`'s fast path; `ANNCHECKV` and the runtime's own
`_checkAnn` short-circuit a passing `PPrimAnn` (primitive AND data-type
annotations) to `pred(val)`. Value construction (object literals, tuples,
refs, structural annotations, updates) and JS-tier nested functions are
JS thunks -- the JS emitter's own code, over the construct's free variables
-- because a literal has a shape V8 wants to see as a literal, and because
it keeps the machine a *control* machine with a small, verifiable surface.

`PYRET_VM_PROFILE=1` prints the executed-instruction histogram, entries,
suspensions and pauses at exit; `node src/ts-compiler/tests/vm-tools.js
disasm|verify|stats <compiled-dir|module.js>` reads what was emitted.

## What is pinned, and how

- `make vm-test`: every program in `tests/async-opt/vm/` and the canonical
  stack/tier programs, built promise and hybrid by the same compiler, must
  produce identical stdout/stderr/exit; heap caps on the space-sensitive
  ones; verifier over what was built.
- `make hybrid-bootstrap-check`: the compiler built all-JS and built hybrid
  each compile the compiler (cold caches); the standalones must be
  byte-identical.
- The promise suites in hybrid: `ts-hybrid-exec-test`, `ts-hybrid-pyret-test`.
- `make vm-unit-test`: opcode-table/format parity, verifier over caches.
- Speed: `tests/async-opt/run-hybrid-table.sh N` (paired, interleaved) and
  `tests/async-opt/vm/bootstrap-time.sh N`.
