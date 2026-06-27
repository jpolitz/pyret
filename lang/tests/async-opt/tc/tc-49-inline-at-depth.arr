#lang pyret
# A top-level helper called INSIDE a nested lambda body. Inlining `f` exposes the
# nested lambda `g`, and the recursive splice should inline `dbl` within g's body
# (the optimizer descends into lambda bodies). The nested lambda also captures the
# outer parameter `n`. f(100): g(5) = dbl(5) + 100 = 10 + 100 = 110.
fun dbl(x): x + x end
fun f(n):
  g = lam(b): dbl(b) + n end
  g(5)
end
print(f(100))
