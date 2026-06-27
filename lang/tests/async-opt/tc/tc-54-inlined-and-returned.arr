#lang pyret
# A local function used BOTH ways at once: called directly in its defining scope
# (so the inliner splices it) AND returned as a first-class value (so its definition
# must survive -- there is no dead-code elimination). The escaped `m.fn` is then
# applied dynamically. Both paths must agree with the cont oracle.
# make-fn: val = f(4) = 16 (inlined locally); run: 16 + m.fn(5) = 16 + 25 = 41.
fun make-fn():
  fun f(x): x * x end
  { fn: f, val: f(4) }
end
fun run():
  m = make-fn()
  m.val + m.fn(5)
end
print(run())
