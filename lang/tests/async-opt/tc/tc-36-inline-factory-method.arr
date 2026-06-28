#lang pyret
# Inlining a FACTORY that returns an object with a method capturing the factory's
# parameter. `mk` is inlined at two sites; each inlined copy's captured `k` must be
# freshened independently so the two objects' methods see k = 2 and k = 3. A binder-
# freshening bug would make both share one k. a.f(10)+b.f(10) = 20 + 30 = 50.
fun mk(k): { method f(self, x): x * k end } end
fun run() block:
  a = mk(2)
  b = mk(3)
  a.f(10) + b.f(10)
end
print(run())
