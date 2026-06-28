#lang pyret
# runcap: 200
# Return-annotation tail-call optimization (the app-info.is-tail vs syntactic
# tail-pos divergence). A `-> Number` function desugars its tail self-call to
#   let ans = down(n-1, ...) in _checkAnn(Number, ans)
# so the call is let-bound (syntactic tail-pos = FALSE) yet app-info.is-tail = TRUE.
# TCO must fire off app-info.is-tail. If it regresses to gating on tail-pos, every
# level retains an awaited async frame -> O(n) heap -> OOM under the 200MB cap. When
# it works the loop is constant-space and the accumulator result is depth-exact.
fun down(n :: Number, acc :: Number) -> Number:
  if n == 0: acc
  else: down(n - 1, acc + 1)
  end
end
print(down(10000000, 0))
