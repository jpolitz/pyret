#lang pyret
# Four-level currying, fully applied, at two instances. Every nesting level captures
# its own freshened parameter; the inliner must thread all four through. f(1)(2)(3)(4)
# = 10 and f(10)(20)(30)(40) = 100, sum 110. Stresses deep capture-chain freshening.
fun f(a): lam(b): lam(c): lam(d): a + b + c + d end end end end
print(f(1)(2)(3)(4) + f(10)(20)(30)(40))
