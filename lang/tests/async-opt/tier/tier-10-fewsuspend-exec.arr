#lang pyret
# FewSuspend-tier EXECUTION fixtures (Stage 5, commit "FewSuspend tier").
# Every fs-* function below is a few-suspend verdict (pinned by
# run-tier-tests.sh via the # expect: headers); run-fewsuspend-exec-tests.sh
# executes this file under the default build AND -no-few-suspend (which
# demotes every few-suspend verdict to Gen inside tier.ts) and pins identical
# output, plus emission deltas and a 256MB-capped deep run.
#
# fs-ping is the shared suspension source: a tail-flat 500-per-fuel-tank TCO
# loop, so fs-ping(small) virtually always returns its value FLAT (sync path
# through the guards) while fs-ping(200000) is guaranteed to exhaust fuel and
# return a promise (suspend path through the resume closures). Each shape is
# exercised with both, so both sides of every `if (R.iT(t))` guard run.
#
#   fs-mid      one mid-body capturing suspend, join code after (S=1 B=0)
#   fs-two      two sequential capturing suspends (S=2, the measured bound)
#   fs-branch   the suspend inside ONE if-branch, fall-through join (S=1 B=1;
#               the aliasing case: the join statements are emitted once after
#               the jIf and aliased into the branch's resume closure)
#   fs-tco-mix  TCO continue on the loop branch, capture only in the exit
#               branch -- `continue` still works when the capture is not on
#               the back-edge (verdict: loopUnsafe=false, tco>0)
#   fs-nested   a nested lambda -- ITSELF few-suspend -- defined inside the
#               outer suspend's continuation: pins the rest-thunk RESET at
#               compileFunBody entry (risk register H: a leaked `rest` would
#               alias the outer continuation into the inner closure)
#   fs-deep     deep NON-tail recursion where every frame few-suspends; run
#               under a 256MB cap (heap linear in depth, JS stack bounded by
#               the fuel tank)
#   fs-var      the suspend as a `var` INITIALIZER (the a-var chain link:
#               the continuation includes the box/unbox declaration)
#   fs-argann   a suspend-class ARGUMENT annotation (Number%(non-flat pred)):
#               the arg check itself is the capturing site, compiled by the
#               reverse fold in compileFunBody (continuation = remaining
#               checks + the whole body)
#   fs-upd      a ref update (a-update -> checkRefAnns: always a capturing
#               site) plus the ref read (needsStep prim): S=2, the bound
#   .m-mid      the same mid-body shape as a METHOD (aMethod arm)
#
# The rejection-identity pins (raise before/after the suspend point) are
# separate crash programs built by run-fewsuspend-exec-tests.sh, since a
# raise ends the run.
#
# expect: fs-ping tail-flat
# expect: fs-mid few-suspend
# expect: fs-two few-suspend
# expect: fs-branch few-suspend
# expect: fs-tco-mix few-suspend
# expect: fs-nested few-suspend
# expect: fs-deep few-suspend
# expect: fs-var few-suspend
# expect: fs-upd few-suspend
# expect: fs-argann few-suspend
# expect: m-mid few-suspend

data FsBox: fs-box(ref bx :: Number) end

fun fs-ping(n :: Number) -> Number:
  if n <= 0: 0
  else: fs-ping(n - 1)
  end
end

fun fs-mid(n :: Number) -> Number:
  x = fs-ping(n)
  x + n + 1
end

fun fs-two(n :: Number) -> Number:
  x = fs-ping(n)
  y = fs-ping(n + 1)
  x + y + 7
end

fun fs-branch(n :: Number, flag) -> Number:
  x = if flag: fs-ping(n) else: 17 end
  x + 2
end

fun fs-tco-mix(n :: Number, acc :: Number) -> Number:
  if n <= 0:
    x = fs-ping(acc)
    x + acc
  else:
    fs-tco-mix(n - 1, acc + 1)
  end
end

fun fs-nested(n :: Number) -> Number:
  x = fs-ping(n)
  f = lam(k :: Number):
    y = fs-ping(k)
    y + k
  end
  f(x + 3)
end

fun fs-deep(n :: Number) -> Number:
  if n <= 0:
    0
  else:
    x = fs-deep(n - 1)
    x + 1
  end
end

fun fs-var(n :: Number) -> Number block:
  var v = fs-ping(n)
  v := v + n
  v + 1
end

fun fs-upd(n :: Number) -> Number block:
  b = fs-box(1)
  b!{bx: n + 1}
  b!bx + 3
end

fun fs-pred(v :: Number) -> Boolean:
  fs-ping(v) == 0
end

fun fs-argann(w :: Number%(fs-pred)) -> Number:
  x = fs-ping(w)
  x + w
end

o = {
  method m-mid(self, n :: Number) -> Number:
    x = fs-ping(n)
    x + n + 5
  end
}

# Sync path (small n: no fuel exhaustion inside the callee)...
print(fs-mid(4))
print(fs-two(4))
print(fs-branch(4, true))
print(fs-branch(4, false))
print(fs-nested(4))
print(fs-var(4))
print(fs-upd(4))
print(fs-argann(4))
print(o.m-mid(4))
# ...and the forced-suspend path (200000 > the ~500-entry fuel tank, so
# fs-ping returns a promise and the resume closures run), same values
# modulo n.
print(fs-mid(200000))
print(fs-two(200000))
print(fs-branch(200000, true))
print(fs-nested(200000))
print(fs-var(200000))
print(fs-upd(200000))
print(fs-argann(200000))
print(o.m-mid(200000))
# TCO loop with an off-back-edge capture: 2M continues, then one suspend.
print(fs-tco-mix(2000000, 0))
# Deep non-tail recursion, every frame capturing: heap-bounded (256MB cap in
# the runner), value pins the full unwind through 200000 resume closures.
print(fs-deep(200000))
