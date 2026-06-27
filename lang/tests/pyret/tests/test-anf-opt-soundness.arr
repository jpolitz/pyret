# Regression tests for the ANF optimizer middle-end
# (lang/src/ts-compiler/src/optimize-anf.ts: inliner + CSE, promise backend).
#
# The optimizer must preserve EXCEPTION ORDERING. A loop-invariant field read
# must never be evaluated ahead of an effect/raise that precedes it in the loop
# body: if it were hoisted to the loop preheader, a field-not-found error could
# surface in place of (and before) the real error. A prototype LICM pass that
# hoisted field reads did exactly this -- it raised the field error instead of
# the program's `raise(...)` -- and was removed for this reason. This case is
# only observable on `--stack-backend promise` with the optimizer enabled (the
# default), so it lives in the main suite, which runs on both backends.

check "optimizer preserves exception order: a preceding raise wins over a later (hoistable) field read":
  obj = { x: 5 }
  fun contribute(o, n):
    shadow n = raise("fail")  # the error that must surface
    o.y + n                   # o.y is field-not-found; must NOT be hoisted before the raise
  end
  fun run-loop():
    for fold(acc from 0, n from [list: 1, 2, 3]):
      acc + contribute(obj, n)
    end
  end
  run-loop() raises "fail"
end
