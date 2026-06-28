#lang pyret
# Curried HOF: `adder` returns a closure. Inlined at two sites, including an immediate
# application `adder(2)(3)` where the returned closure is called right away. Captures
# must stay independent (add5 closes over 5; the immediate one over 2).
# add5(10) + adder(2)(3) = 15 + 5 = 20.
fun adder(a): lam(b): a + b end end
fun run() block:
  add5 = adder(5)
  add5(10) + adder(2)(3)
end
print(run())
