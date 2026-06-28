# Regression tests for the ANF optimizer middle-end
# (lang/src/ts-compiler/src/optimize-anf.ts: inliner + CSE + LICM, promise backend).
#
# The optimizer must preserve EXCEPTION ORDERING. A loop-invariant field read
# must never be evaluated ahead of an effect/raise that precedes it in the loop
# body: if it were hoisted to the loop preheader, a field-not-found error could
# surface in place of (and before) the real error. A prototype LICM pass that
# *hoisted* field reads did exactly this -- it raised the field error instead of
# the program's `raise(...)`. LICM was revived as a cross-iteration write-once
# CACHE instead (optimize-anf.ts): the read keeps its original program point and
# compiles to `cacheVar ??= getField(...)`, so the first iteration to reach it
# evaluates getField exactly where the source did -- a preceding raise (this
# test) or a zero-trip loop still wins -- and later iterations reuse the cell.
# This case is only observable on `--stack-backend promise` with the optimizer
# enabled (the default), so it lives in the main suite, which runs on both
# backends.

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

check "optimizer preserves zero-trip semantics: a cached invariant read on a never-run body never faults":
  obj = { x: 5 }
  fun zero-trip():
    # obj.missing would be field-not-found, but the body never runs, so the
    # cached read must never be evaluated (no preheader hoist).
    for fold(acc from 99, n from [list: ]):
      acc + obj.missing
    end
  end
  zero-trip() is 99
end

check "optimizer's cross-iteration field cache returns the right value every iteration":
  obj = { factor: 10 }
  fun sum-scaled(o, xs):
    for fold(acc from 0, x from xs):
      acc + (x * o.factor)   # o.factor is loop-invariant -> cached across iterations
    end
  end
  sum-scaled(obj, [list: 1, 2, 3, 4, 5]) is 150
end
