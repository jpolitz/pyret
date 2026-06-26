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
fired via `continue` present in the optimized build but not the baseline. All 14 PASS.

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
