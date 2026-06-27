#lang pyret
# A function held in a `var`, reassigned, must dispatch DYNAMICALLY -- the inliner
# may not freeze it to one body. `f` is called before and after reassignment, so a
# correct run sees both bodies (11 then 1000 -> 1011). If the inliner ever inlined
# the var read with a fixed body, the two calls would agree and diverge from the
# cont oracle.
fun run() block:
  var f = lam(x): x + 1 end
  before = f(10)
  f := lam(x): x * 100 end
  after = f(10)
  before + after
end
print(run())
