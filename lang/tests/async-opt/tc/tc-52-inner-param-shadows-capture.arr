#lang pyret
# A nested lambda whose PARAMETER shadows an outer local of the same name `k`. The
# inlined body uses the outer `k` (n*100) while the lambda's body uses its own param
# `k`. Inlined at two sites; freshening must keep the shadowed names distinct per
# site. f(n) = (n + 1) + (n * 100): f(2) = 203, f(5) = 506, sum 709.
# (`shadow` is required by well-formedness for the intentional re-binding of `k`.)
fun f(n):
  k = n * 100
  g = lam(shadow k): k + 1 end
  g(n) + k
end
fun run(): f(2) + f(5) end
print(run())
