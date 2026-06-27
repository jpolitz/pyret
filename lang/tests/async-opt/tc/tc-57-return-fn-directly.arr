#lang pyret
# The function is RETURNED DIRECTLY (not wrapped in a record), while also being called
# locally for effect (the inlined call writes a captured `var`). The escaped function
# is applied later. make-adder(10): the local `helper(7)` (inlined) sets trace = 17, and
# `helper` escapes; run: f(100) + trace = 110 + 17 = 127.
var trace = 0
fun make-adder(base) block:
  helper = lam(x): x + base end
  trace := helper(7)
  helper
end
fun run() block:
  f = make-adder(10)
  f(100) + trace
end
print(run())
