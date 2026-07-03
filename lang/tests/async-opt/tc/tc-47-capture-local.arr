#lang pyret
# A nested lambda captures an outer LOCAL binding (not a parameter). Inlining `f`
# freshens `base`, and the nested `adder` must capture that same freshened `base`.
# f(3): base = 30, adder(5) = 5 + 30 = 35. If the capture points at the wrong (un-
# freshened or absent) binding, the result diverges from the cont oracle.
fun f(n):
  base = n * 10
  adder = lam(x): x + base end
  adder(5)
end
print(f(3))
