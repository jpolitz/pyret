# Cross-module method-flatness oracle (`make ts-mf-test`)

A **fast** soundness oracle for the promise backend's cross-module method flatness
(`flatness.ts` `buildImportedFlatMethods` + `string-dict.js`'s declared
`method-flatness`). ~18s, vs the ~10-minute cold rebuild of the full main2 promise
suite — which is also an *unreliable* oracle here: it only ever exercised these
flat-tagged methods because the compiler itself happens to call them via nested
`run-task` compiles, and it silently missed the cold-vs-cached flattening gap
(`canonicalizeDataExport` was dropping `methodFlatness`) entirely.

## What it does

Each `mf-*.arr` **explicitly calls every flat-tagged builtin method** on a *typed*
receiver (so the call actually flattens), and uses the result in a leak-observable way
(summed / printed). The runner compiles each three ways with the same `ts-compiler`:

1. `--stack-backend promise` (default) — the optimization ON
2. `--stack-backend promise -no-imported-method-flat` — the oracle (OFF)
3. `--stack-backend cont` — the other backend

and asserts:

- **sound**: all three outputs identical. A method wrongly flattened (emitted no-await
  while it actually suspends — e.g. `keys`/`keys-now`, which build a tree-set via Pyret
  AVL insertion and *can* suspend) leaks a `Promise { <pending> }` under (1) and diverges.
- **fired**: (1) has fewer `R.iT` await-guards than (2). Catches "the optimization
  silently stopped working" regressions (like the cold-compile bug above).

## Adding a case

Drop in `mf-NN-<name>.arr` that calls the methods of interest **on an annotated param /
typed return** (an unannotated `[SD.mutable-string-dict:]` construction does *not*
resolve a receiver type, so its calls never flatten and won't test anything), and prints
a deterministic result. Verified to catch a real bug: temporarily add `"keys": 0` /
`"keys-now": 0` to `string-dict.js`'s `method-flatness` and the run turns `UNSOUND`.
