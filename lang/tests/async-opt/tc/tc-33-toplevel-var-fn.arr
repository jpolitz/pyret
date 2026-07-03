#lang pyret
# Top-level `var` function read through a wrapper. `call-it` reads the mutable `op`
# (an a-id-var read, which the inliner must NOT treat as a direct call). Reassigning
# `op` between calls must change what `call-it` does (11 then 1000 -> 1011). Inlining
# `op` into `call-it` would freeze the old body.
var op = lam(x): x + 1 end
fun call-it(x): op(x) end
fun run() block:
  v1 = call-it(10)
  op := lam(x): x * 100 end
  v2 = call-it(10)
  v1 + v2
end
print(run())
