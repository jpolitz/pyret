#lang pyret
# Method APPLICATIONS dispatch dynamically and must never be inlined/collapsed: two
# distinct objects share the method name `val` but have different bodies. The calls
# must resolve to each object's own body (10, 20, 10 -> 40), not be folded to one.
fun run() block:
  a = { method val(self): 10 end }
  b = { method val(self): 20 end }
  a.val() + b.val() + a.val()
end
print(run())
