#lang pyret
# The optimizer recurses into METHOD bodies (optLettable a-method): a top-level
# helper called inside a method must be inlined there, while `self` access is
# preserved. `get` calls `add-ten(self.v)`; inlining add-ten must keep self.v = 5,
# giving 15.
fun add-ten(n): n + 10 end
o = {
  v: 5,
  method get(self): add-ten(self.v) end
}
print(o.get())
