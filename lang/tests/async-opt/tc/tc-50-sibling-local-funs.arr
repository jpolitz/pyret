#lang pyret
# Two sibling LOCAL functions where one calls the other (non-recursive). Inlining
# `outer` splices both nested defs; `b` calls sibling `a`, which the cascade splice
# can further inline. Binders of both must be freshened without cross-talk.
# outer(5): b(5) = a(5) * 2 = 12, a(5) = 6, sum = 18.
fun outer(n):
  fun a(x): x + 1 end
  fun b(x): a(x) * 2 end
  b(n) + a(n)
end
print(outer(5))
