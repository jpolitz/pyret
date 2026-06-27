#lang pyret
# A `var` function reassigned MORE than once: collectFunDefs drops any name assigned
# beyond its single letrec init (assignCounts > 1), so `g` is never a stable inline
# target. Three states must each be observed (11 / 12 / 13). Exercises the multi-
# reassignment drop specifically (vs the single reassignment in tc-32).
fun run() block:
  var g = lam(x): x + 1 end
  r1 = g(10)
  g := lam(x): x + 2 end
  r2 = g(10)
  g := lam(x): x + 3 end
  r3 = g(10)
  num-to-string(r1) + "/" + num-to-string(r2) + "/" + num-to-string(r3)
end
print(run())
