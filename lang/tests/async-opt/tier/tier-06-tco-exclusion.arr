#lang pyret
# The arg-used-in-nested-lambda TCO exclusion, now computed by the tier pass:
# the formal `n` is captured by the inner lambda, so allowTco=false and the
# self tail call is NOT a TCO continue -- it classifies as a tail-position
# direct-return suspend site instead (S=0, tail=1) => still TailFlat, but the
# verdict must carry allowTco=false (codegen emits no while(true) loop).
# The inner lambda is flat and never leaks the outer tier (node-keyed map).
# expect: tier-capt tail-flat
# expect-allowtco: tier-capt false

fun tier-capt(n :: Number):
  f = lam(): n end
  if n <= 0: f()
  else: tier-capt(n - 1)
  end
end

print(tier-capt(3))
