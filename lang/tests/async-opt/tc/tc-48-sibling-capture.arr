#lang pyret
# Two sibling nested lambdas that capture the SAME outer local. After inlining `f`,
# both `g` and `h` must close over the one freshened `shared` (not two different
# copies). f(3): shared = 4, g(10) = 14, h(10) = 40, sum = 54.
fun f(n):
  shared = n + 1
  g = lam(x): x + shared end
  h = lam(x): x * shared end
  g(10) + h(10)
end
print(f(3))
