#lang pyret
# runcap: 200
# Inliner x tail call, ARGUMENT-position case. `bump` is a small non-recursive
# annotated helper called in argument position of a deep self-tail loop. The
# inliner splices bump's body into the loop (no bump.app left) -- it must NOT
# disturb the pre-computed tail info / formal rebind of the self-tail call `go(...)`,
# which has to stay a TCO `continue`. If inlining breaks that, the loop goes O(n)
# heap -> OOM under the cap; the depth-exact result also catches a bad inline.
fun bump(x :: Number) -> Number:
  x + 1
end
fun go(n :: Number, acc :: Number) -> Number:
  if n == 0: acc
  else: go(n - 1, bump(acc))
  end
end
print(go(10000000, 0))
