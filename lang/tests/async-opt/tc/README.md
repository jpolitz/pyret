# Corner-case tests: tail-call-in-effect-position optimization

Tests for the optimization in `src/ts-compiler/src/ast-util.ts` `SetTailVisitor.sIfElse`,
which marks a discarded self-recursive call (followed only by a pure suffix equal to the
`else` value) as a tail call so the existing TCO `continue` fires.

## Running
`bash run-corner-tests.sh` (from the `lang/` dir). For each test it compiles three ways:
- **optimized** (default, promise backend)
- **baseline** (`-no-effect-tail-calls`, promise) — the un-optimized ground-truth oracle
- **optimized** (cont backend)

It asserts all three produce identical output (correctness), and detects whether OUR rule
fired via `continue` present in the optimized build but not the baseline. All 57 PASS.

A test may add a `# runcap: N` header to cap its run-time heap at N MB (default: the
global `CAP`). The space-sensitive tests below use a tight cap so that a TCO regression
-- which leaks one async frame per level while leaving the *result* correct right up
until memory runs out -- surfaces as an OOM (an output mismatch the harness already
checks) rather than silently passing. Verified live: re-introducing the old
`compiler.tailPos &&` gate makes tc-15 and tc-16 OOM at their 200MB cap (corr=FAIL).

## Seeing the inliner: `-inline-comments`
Pass `-inline-comments` when building (promise backend) to emit a `// inlined: <callee>`
JS comment at every inline site in the compiled `-module.js`. The ANF inliner prepends a
never-read marker `let` at each splice (`optimize-anf.ts` `INLINE_MARKER_BASE`), which the
async loop compiler renders as the comment and otherwise drops. Off by default -> normal
builds are byte-for-byte unchanged; the flag is purely for inspecting what got inlined:
```
make tests/async-opt/foo.ts.p.jarr EF='-no-check-mode -inline-comments'   # then grep '// inlined:' the module
```

## What each test covers
- tc-01 `when`-loop, var mutation, suffix `nothing` == else `nothing`        -> optimizes
- tc-02 accumulator, suffix mutable var `acc` == else `acc`                   -> optimizes
- tc-03 suffix immutable let-bound id `d` == else `d`                         -> optimizes
- tc-04 matching numeric constants `7`/`7` (=== on PyretNumber catches it)    -> optimizes
- tc-05 mismatched constants `5`/`10` (THE soundness case; must yield 5)      -> NOT (correct)
- tc-06 suffix var `a` != else var `b` (must yield 1)                         -> NOT (correct)
- tc-07 effectful suffix `print` (all 5 effects must fire)                    -> NOT
- tc-08 mutation (`:=`) after the recursive call                             -> NOT
- tc-09 let-binding before the call (`doubled = ...`)                         -> NOT (see Limitation)
- tc-10 string suffix `"ok"` == else `"ok"` (exercises SStr equality)        -> optimizes
- tc-11 genuine tail call (no suffix) -- optimized by pre-existing TCO        -> (both modes)
- tc-12 mutual recursion (not self-recursive)                                -> NOT
- tc-13 multi-branch elif -- desugars to nested if-else; inner arm optimizes  -> optimizes (sound)
- tc-14 else is a complex expr (if-else), so else-tail is not pure            -> NOT

### Tail-call machinery regression tests (added from the TRO/inliner investigation)
These do not exercise the effect-position rule (so `fired` is `no`); they guard that the
*other* tail-call paths keep their TCO `continue`. The deep ones (`# runcap`) are space
tests -- a broken tail call OOMs under the cap; the shallow ones are value/oracle checks.
- tc-15 return-annotation deep tail loop (`-> Number`): tail self-call is let-bound by
  `_checkAnn` wrapping (syntactic tail-pos = false) yet app-info.is-tail = true. TCO must
  fire off app-info.is-tail or it goes O(n) heap. runcap 200, depth 10M -> 10000000.
- tc-16 inliner, ARGUMENT position: a small non-recursive helper inlined into the arg of a
  deep self-tail loop must not disturb that loop's `continue`. runcap 200, depth 10M.
- tc-17 inliner, TAIL position (plugTail): a non-recursive call spliced as the base-case
  tail value must preserve the result and not be mis-marked as a tail call. Value oracle.
- tc-18 STALE pre-computed tail info: a recursive (un-inlined) `g` is tail-called inside a
  non-recursive `h`; inlining `h` into argument (non-tail) position leaves `g`'s node
  wearing a stale is-tail = true. The result must still match the cont oracle -- pins that
  the is-recursive half of the TCO gate keeps a stale is-tail flag from misfiring.
- tc-19 mutual recursion x token minting x inliner (regression for a fixed bug): mutually
  recursive ping/pong are non-flat, so they bounce via safe-for-space TOKENS (makeTailFunction),
  not `continue`. The inliner must not inline a cycle member. The optimizer's call graph was
  dropping FORWARD letrec references (`a-id-letrec`, the uninitialized-guarded read a function
  makes to a sibling defined later), so the cycle went undetected, ping got inlined into pong,
  pong lost its driver, and deep mutual recursion OOMed under the optimizer. Fixed by following
  single-id aliases in optimize-anf.ts `calleesOf`. runcap 200, depth 10M -> OOMs if regressed.

### Inliner stress tests (tc-20..tc-31)
A dozen probing the inliner from distinct angles. The cont backend (no optimizer) is the
oracle: every test's optimized-promise output must match it, so any inliner-introduced
behavior change is caught. Recursion-detection / safe-for-space cases use `# runcap` (OOM
if a cycle member is wrongly inlined); the rest are value/error oracles. Raising tests rely
on the harness stripping the (backend-divergent) `Pyret stack:` trace before comparing.
- tc-20 3-node mutual cycle a->b->c->a, deep: multi-hop cycle must be detected (two forward
  edges). runcap 200.
- tc-21 mutual recursion reached only through an explicit alias `alt = pong`: the call graph
  must follow the single-id alias or the cycle is invisible. runcap 200.
- tc-22 thin wrapper inside a cycle (loop<->step): a tiny, maximally-inlinable cycle member
  must still be left alone. runcap 200.
- tc-23 nested chain a->b->c->d: recursive splice collapses the chain; value oracle.
- tc-24 closure capture: inlining `adder` at two sites must freshen binders so the returned
  closures capture independent `n`s. value oracle.
- tc-25 argument evaluation ORDER preserved (three effectful args -> "123"). value oracle.
- tc-26 argument evaluated ONCE though the parameter is used twice (counts calls -> "14/1").
- tc-27 effect-position inline (discarded result) fires exactly once, in order -> "xy".
- tc-28 inlining inside if-arms and a cases-arm; each branch value stays correct.
- tc-29 parameter annotation check PRESERVED through inlining (bad arg must still raise).
- tc-30 return annotation check PRESERVED through inlining (bad return must still raise).
- tc-31 inliner x CSE: inlining a field-read helper at 3 sites then CSE-collapsing stays correct.

### Methods, var reassignment, higher-order functions (tc-32..tc-43)
- tc-32 a `var` function called before/after reassignment must dispatch dynamically (1011).
- tc-33 top-level `var` function read through a wrapper; reassignment must take effect (1011).
- tc-34 a `var` function reassigned >1 time (assignCounts drop) -> never inlined ("11/12/13").
- tc-35 a helper inlined INSIDE a method body, `self` preserved (15).
- tc-36 inlining a factory returning an object whose method captures the factory param;
  two instances must capture independent values (50).
- tc-37 method applications dispatch dynamically and are never collapsed (40).
- tc-38 deep self-recursive METHOD stays safe-for-space via the method bounce token. runcap 200.
- tc-39 a higher-order helper is inlined but the call through its function parameter stays dynamic (12).
- tc-40 the same function used both as a direct (inlined) call and as a first-class HOF value (12).
- tc-41 a recursive HOF is not inlined; its function argument is applied per level (30).
- tc-42 curried HOF inlined, including immediate application `adder(2)(3)` (20).
- tc-43 a named function passed to a built-in (cross-module) HOF is not inlined ([list: 1, 4, 9, 16]).

### Deeply nested function definitions: substitution / capture / shadowing (tc-44..tc-53)
Non-recursive nesting that stresses the inliner's binder freshening and capture handling
(collectBinders + Renamer descend into nested lam/method bodies).
- tc-44 three-level currying, partial application, two instances -> independent captures (579).
- tc-45 inner lambda parameter shadows the outer function parameter of the same name (501).
- tc-46 a local `fun` inside an inlined function is cascade-inlined; nested binders freshened (25).
- tc-47 a nested lambda captures an outer LOCAL binding (not a parameter) (35).
- tc-48 two sibling nested lambdas capture the SAME outer local (54).
- tc-49 a top-level helper is inlined INSIDE a nested lambda body (descend into lambdas) (110).
- tc-50 two sibling local functions, one calling the other (cascade, no cross-talk) (18).
- tc-51 four-level currying fully applied, two instances -> deep capture-chain freshening (110).
- tc-52 a nested lambda parameter shadows a captured local of the same name, at two sites (709).
- tc-53 a nested lambda closes over and MUTATES a local `var` of the inlined function (115).

### Inlined AND returned: a function used at a local call site that also escapes (tc-54..tc-57)
The inliner has no dead-code elimination, so a function that is both called directly
(inlined) and returned as a value must keep its definition for the escaping use, and the
inlined clone must stay consistent with the returned original.
- tc-54 local `fun` called locally (inlined) and returned in a record; escaped `m.fn` applied (41).
- tc-55 a capturing closure called locally AND escaped, at two instances -> right captures (2202).
- tc-56 the inlined result and the escaped-then-called result must AGREE for the same arg ("71/71").
- tc-57 the function is returned DIRECTLY (not in a record) while a local inlined call writes a
  captured `var` (127).

## Findings
1. **Surface Pyret forbids standalone pure statements** (well-formedness), so a "long chain"
   of bare constants/vars in the suffix is not expressible; the pure suffix is in practice a
   single value expression (the block's last expr). The multi-pure-suffix path in
   `effectTailCall` is only reachable via compiler-internal desugaring.
2. **Coverage LIMITATION (tc-09):** a `let`-binding before the recursive call desugars to an
   `SLetExpr` wrapping the block, which `sIfElse` does not look through, so the optimization
   bails (sound, but misses). Loops that only use `:=` (assignment) are unaffected. Fixable by
   unwrapping leading `SLetExpr`/`SLetrec` in `effectTailCall`.
3. **elif is sound (tc-13):** `else if` desugars to nested single-branch if-elses, so the rule
   optimizes inner arms where the suffix matches that arm's else, and leaves others alone.
