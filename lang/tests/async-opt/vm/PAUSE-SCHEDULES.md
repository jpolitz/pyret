# Pause-schedule correspondence: Cont vs the async VM

*Report written by the Claude agent (session of 2026-08-24/25); not
human-authored. The prose here describes agent-built tooling and
agent-measured results.*

## What this is

Infrastructure and results for the byte-oracle goal: run both stack
backends under **deterministic pause schedules** (instead of the constant
GAS/RUNGAS), record the **stack at every pause**, and check that the cont
backend and the hybrid bytecode machine correspond — same pause points,
same stacks — and that answers are schedule- and optimization-invariant.

## The apparatus

Runtime-only changes (no codegen changes); everything is off unless the
env var is set:

- `PYRET_PAUSE_SCHEDULE=fixed:N | list:a,b,... | lcg:seed:min:max` puts
  either runtime into schedule mode: one monotone **fuel-event counter**
  replaces GAS and RUNGAS, and a pause fires when the countdown hits the
  next scheduled interval. An event is: a non-flat function entry, a
  bytecode call (CALL/TAILCALL/METHCALL/METHCALLD; machine quantum forced
  to 1), a machine entry from JS, or one iteration of a runtime builtin
  loop (`raw-array-map` etc.). Interval bounds: min 2 (a fuel re-check
  after a builtin pause re-counts, so interval 1 makes no progress), max
  ~1000 (between pauses the cont backend grows the JS stack one frame per
  entry; the interval is the stack bound — this is what `GAS = 500` is
  for).
- In cont, emitted code's inline `--R.GAS`/`--R.RUNGAS` checks are
  intercepted by accessors installed on the runtime object (entry checks
  count one event; the paired RUNGAS decrement, exits, and resets do
  not; the TCO self-call decrement counts one). Runtime builtins consult
  the schedule directly. The trampoline skips the re-run entry check of
  a resumed compiled frame — the async backend charges nothing on an
  await resume — and the machine symmetrically skips the retried
  instruction's charge after a fuel pause.
- `PYRET_PAUSE_TRACE=file` writes one line per pause: pause index, event
  index, and the stack, innermost first. Cont captures `theOneTrueStack`
  at the bounce; the machine captures parked frames (states, bailouts) as
  the suspension unwinds, closing each pause's record on the next
  microtask. Frames are cycle-compressed (`f1 ~ f2 x400`), runtime
  builtin frames are marked `B:`, capture depth is capped
  (`PYRET_PAUSE_CAPTURE_DEPTH`, default 4000), and traces flush
  incrementally.
- `tests/async-opt/vm/pause-compare.js` checks two traces: same event
  totals, same per-pause event indices, and per pause the two stacks must
  agree frame-by-frame from the top after dropping `B:` frames; leftover
  outermost frames (module toplevels, the module-load `safeCall`
  pedestal — visible only to cont) are reported as residue, never
  matched. It walks compressed runs, so million-frame stacks compare in
  O(runs).
- `tests/async-opt/vm/run-pause-tests.sh` drives it: per program, four
  builds (cont; vm nonflat/`--vm-fast none`; vm nonflat/`all`; production
  promise gen/all) run under a battery of schedules; answers must be
  identical everywhere; stacks compared cont↔vm-none (source-loc key) and
  vm-none↔vm-all (name+def-loc key).

### What "same optimizations" required

The promise pipeline's middle-end is promise-only (cont codegen is frozen
for byte-parity), so the correspondence builds pin: `-no-optimize`
(inliner/CSE/LICM — inlining deletes the callee's entry event and its
frame), `-no-direct-fields`, `-no-method-flatness`, `-no-op-weakening`,
and `--inline-case-body-limit 1000000` on **both** backends (the cont
backend lifts a cases branch bigger than the limit into a function whose
entry charges fuel; the machine always runs branches inline). Ann
elision stays **on**: elided checks never charge fuel, and without it a
return-annotated tail call's continuation is not RETURN, so the machine
loses TAILCALL frame reuse and annotated TCO loops stack frames.

### The pending-call-site model

A cont frame's identity at a pause is its `apploc`. The machine mirrors
it with a shadow `locKS` updated exactly where cont updates `apploc`:
split applications, non-self tail calls, argument/bind annotation checks
(including the ANNCHECKV fast path), field access (DOT), prim-apps, and
cases dispatch — and **not** at method calls, colon access, flat calls,
or self tail calls. The machine's fuel pause at a call instruction fires
before the callee frame exists, so the comparer's callee frame is
synthesized there (skipped for self tail calls, where the reused frame
*is* the callee's record; for non-self tail calls the dead caller frame
is dropped, matching cont's proper-tail-call non-attachment).

## Results

### Answers (schedule- and optimization-invariance)

All **18 programs** (the vm suite, tier programs, TCO suites, v-var
family): stdout + exit code **identical** across
{cont, vm-none, vm-all, production promise} × {no schedule, 2–4
schedules each} — 20 runs per program.

Whole-suite: `main2-exec` minus the three canvas-dependent test files
(the checked-in `canvas.node` is a mac-arm64 binary; the one
`test-file.arr` mtime test fails identically everywhere) — see the
main2 section below.

### Stacks at pauses (cont ↔ vm-none, and vm-none ↔ vm-all)

Across all programs and schedules: **6,233,352 pauses compared**:

- 2,694,353 exact (identical stacks after dropping runtime-builtin
  frames),
- 3,536,826 top-segment matches (the VM stack equals the top of the cont
  stack; the residue is the cont-only bottom: module toplevel frames and
  the module-load `safeCall` pedestal — the async backend's toplevels
  are plain `async` functions with no inspectable frame),
- **2,173 frame mismatches (0.03%)**, all in the four classes below.

Deep recursion is covered at full depth: `vm-01-cross-deep` (300k-deep
Gen/TailFlat alternation) matches at every pause; `v-var`/`v-func` style
loop suites match across 20k–1.1M pauses per run (v-func vm-none↔vm-all:
1,142,858 pauses, all exact).

### The divergence classes (same answers, different stacks — by design)

- **A. Check-block body lifting (vm-06).** For `fun f(k) block: …
  check: … end … end` the cont backend splits the body into a lifted
  block-lambda (tail-called by the wrapper, so the wrapper's frame is
  gone), while the machine keeps one `f` frame. ±1 frame and different
  pending locs around `run-checks`.
- **B. TCO exclusion (tier-06).** When a formal is captured by a nested
  lambda, cont sets `allowTco=false` and stacks real activation records;
  the machine's frame reuse is still safe (upvalues are captured by
  value at CLOSURE time), so it keeps **one** frame where cont keeps N.
  The machine out-tail-calls the cont backend here.
- **C. No tail METHCALL in the machine (mutual-tco-test).** Method- and
  mixed function↔method mutual tail recursion: cont pumps
  TailMethodCall tokens through one driver (O(1) records); the machine
  has no tail method call, so it accumulates one frame per method-tail
  step (bounded heap, right answers, ~N-deep stacks-at-pause). This is
  1,003+1,143 of the 2,173 mismatches.
- **D. Fast forms run on the JS stack (vm-all).** Under `--vm-fast all`
  a for-body/where-block thunk that vm-none holds as a machine frame is
  a native JS frame in vm-all until it bails; method-mutual recursion
  runs through the JS maybe-promise driver entirely, so vm-all's parked
  stacks are shallower than vm-none's at the same pause (17 mismatch
  pauses total).

- **E. The equality engines.** The cont backend's `equal-always` is a
  safeCall-driven step machine whose helpers park runtime records; the
  async backend's is a synchronous maybe-promise worklist that parks a
  single promise. When a schedule pause lands inside a *user `_equals`*
  mid-comparison, the two backends' parked shapes differ (cont shows the
  equality helpers' records; the machine shows only the `_equals`
  frames). Answers agree.

### Bugs and asymmetries found on the way (in the backends, not the tooling)

- **A real crash bug in `string-dict.js` (fixed in this branch)**: the
  cont-backend suspension path of `eqHelp` referenced `thisRuntime`
  (undefined in that module), restored from a variable typo'd as `sekf`,
  and attached an activation record with no saved state and an undefined
  resume function — three independent bugs on one path, i.e. it had
  never run. Any cont program whose stack pause lands inside a
  string-dict equality while a user `_equals` is suspending crashed with
  `ReferenceError: thisRuntime is not defined`. The pause-schedule
  oracle hit it on `main2-exec` under `fixed:997`
  (`test-compile-errors.arr` went 8/8 → 7/8); a 300-key dict of
  custom-`_equals` values reproduces it at every schedule interval
  tried. Fixed and verified (crashes before, passes after, at
  `fixed:3..97`, both backends).

- The ANF optimizer, op weakening, direct fields, method flatness, ann
  elision, and tier analysis are all promise-only. Under default flags
  the two backends genuinely pause at different points (an inlined
  callee's entry event vanishes) — not a bug, but it means "same
  schedule ⇒ same stacks" only holds with the middle-end pinned off.
- `-no-ann-elision` (a supported flag combination) silently disables
  machine TAILCALL for return-annotated tail calls — annotated mutual
  TCO loops then keep O(N) machine frames. Answers stay right; memory
  and stacks don't match the elided build. Worth knowing when comparing
  `--vm-fast`/tier configurations under the no-opt flags.
- The cont backend's `apploc` is stale across flat calls, method calls,
  prim calls and self-TCO iterations (it only updates at split-app /
  ann-check / dot sites). The machine's error-attribution `locK` updates
  at every call. So the two backends can *blame different source
  positions* for the "same" frame in a rendered stack — the machine's
  is the more precise one. (Exception stacks in the async backend come
  from the JS `Error.stack` parser for JS frames, so this shows up at
  pause-stacks, not error output, in the current pinning.)
- Under schedule mode with intervals > ~1000 the cont backend simply
  overflows the JS stack on deep recursion — a nice direct confirmation
  that `INITIAL_GAS` is a stack bound, not a time slice.
- `fixed:1` (pause on every event) livelocks both backends by design:
  builtin-loop fuel re-checks re-count the same iteration after a pause,
  so the minimum useful interval is 2.

## How to run

```
make ts-compiler
bash tests/async-opt/vm/run-pause-tests.sh            # full battery
PROGS=... SCHEDULES=... WORK=... KEEP=1 bash ...      # overrides
```

Manual runs:

```
PYRET_PAUSE_SCHEDULE=lcg:42:2:300 PYRET_PAUSE_TRACE=/tmp/a.trace node prog.cont.jarr
PYRET_PAUSE_SCHEDULE=lcg:42:2:300 PYRET_PAUSE_TRACE=/tmp/b.trace node prog.vmnone.jarr
node tests/async-opt/vm/pause-compare.js /tmp/a.trace /tmp/b.trace
```

## main2-exec (whole execution suite)

`main2-exec` minus the three canvas-dependent test files, `-check-all`
(12,860 tests), three configs (cont; vm nonflat/none; production
promise), baseline plus schedules `fixed:997` and `lcg:11:300:1200`,
stacks sampled every 101st pause (`PYRET_PAUSE_TRACE_SAMPLE`).

- **Answers**: every run of every config exits 4 with the same
  12,859-passed / 1-failed summary (the failure is `test-file.arr`'s
  file-mtime check — environment, not backend) — except the one
  schedule-sensitive crash that turned out to be the `string-dict.js`
  bug below, gone after the fix. The per-block result *lines* print in
  different orders (between builds AND between schedules of one build)
  but the sorted outputs are byte-identical — rendering order, not
  results. With default (production) flags the cont and promise builds
  print identically; the ordering wobble appears only under the
  correspondence pinning.
- **Pause points**: over the *entire shared execution* — 1.539 billion
  fuel events, 2.05 million pauses (20,314 sampled and checked) — the
  two backends pause at **exactly the same event indices**. The cont run
  then continues for a further ~600 M events the promise run never
  executes: `test-anf-opt-soundness.arr` drives the Pyret-hosted
  compiler *matched to the build's own backend*, so the cont build
  finishes by running `anf-loop-compiler.arr`'s codegen where the
  promise build ran `anf-loop-compiler-async.arr`'s — different program
  text by design, and visible in the totals (2.142 B vs 1.539 B).
- **Stacks**: main2 lives almost entirely inside check blocks, so the
  class-A shape difference (check-block body lifting) applies to nearly
  every pause; frame-exact stack comparison over main2 certifies pause
  points, not shapes. The frame-exact stack claims come from the
  program suite above, which covers the same runtime machinery outside
  check-block bodies.
