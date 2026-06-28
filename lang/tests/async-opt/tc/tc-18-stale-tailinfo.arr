#lang pyret
# Adversarial: pre-computed tail info that goes STALE under inlining.
# `g` is recursive, so it is never inlined and its call node survives. Inside the
# non-recursive `h`, the call `g(x)` is in tail position, so app-info.is-tail was set
# TRUE on that node. The inliner then splices `h` into the ARGUMENT position of
# `outer`'s self-tail call, where `g(...)` is no longer tail -- yet its node still
# carries the stale is-tail = TRUE. Nothing may trust that stale flag to fire a
# `continue` (which would hijack outer's loop) or to skip a check: the result must
# equal the cont-backend oracle. is-recursive (also pre-computed, relative to h) is
# what actually guards the TCO gate here, so this pins that the gate stays sound when
# a non-tail call wears a stale is-tail flag. h(2) = g(2) = 7, so the answer is 1000*7.
fun g(x :: Number) -> Number:
  if x <= 0: 7
  else: g(x - 1)
  end
end
fun h(x :: Number) -> Number:
  g(x)
end
fun outer(n :: Number, acc :: Number) -> Number:
  if n == 0: acc
  else: outer(n - 1, acc + h(2))
  end
end
print(outer(1000, 0))
