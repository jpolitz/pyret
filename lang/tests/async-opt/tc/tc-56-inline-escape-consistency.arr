#lang pyret
# Consistency: the INLINED call and the ESCAPED-then-called value of the same function
# must produce identical results for the same argument. `g(7)` is inlined into the
# record's `inlined` field; `m.fn(7)` calls the escaped `g`. If the inlined clone ever
# diverged from the original definition, the two would disagree. Expect "71/71".
fun mk():
  fun g(x): (x * 10) + 1 end
  { inlined: g(7), fn: g }
end
fun run():
  m = mk()
  num-to-string(m.inlined) + "/" + num-to-string(m.fn(7))
end
print(run())
