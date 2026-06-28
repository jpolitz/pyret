#lang pyret
# Shadowing across nesting: the inner lambda's parameter `x` shadows the outer
# function's parameter `x`. Inlining `outer` must keep the two `x` binders distinct
# (the arg to inner uses the OUTER x; inner's body uses its OWN x). outer(5) feeds
# inner(500); inner adds 1 -> 501. Conflating the two x's would change the result.
# (`shadow` is required by well-formedness for the intentional re-binding.)
fun outer(x):
  inner = lam(shadow x): x + 1 end
  inner(x * 100)
end
print(outer(5))
