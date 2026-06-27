#lang pyret
# Capture-avoidance / closure freshening. `adder` returns a lambda that captures its
# parameter `n`. Inlining `adder` at two sites must freshen the callee's binders so
# the two returned closures capture INDEPENDENT n's (7 and 100); a freshening bug
# would make them share a binder and collapse to one value.
fun adder(n): lam(x): x + n end end
fun run():
  f = adder(7)
  g = adder(100)
  f(1) + g(2)
end
print(run())
