#lang pyret
# Three-level currying, inlined, with PARTIAL application stored then applied. `f` is
# inlined at two sites; the nested lambdas must capture each level's freshened var
# independently across the two instances. g=f(1) then g(2)(3) = 123; h=f(4), h(5)(6)
# = 456; sum 579. A capture/freshening bug across nesting levels or sites diverges.
fun f(a): lam(b): lam(c): (a * 100) + (b * 10) + c end end end
fun run() block:
  g = f(1)
  h = f(4)
  g(2)(3) + h(5)(6)
end
print(run())
